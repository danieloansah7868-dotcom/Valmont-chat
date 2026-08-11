/**
 * VChat — realtime layer (Socket.io) + upload/REST endpoints.
 *
 *   const messenger = require('./lib/messenger');
 *   messenger.attach(httpServer, expressApp);
 */

const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const store = require('./messenger-store');
const sms = require('./sms');

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|svg|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|zip|mp3|wav|ogg|webm|m4a|mp4|mov)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  },
});

function attach(httpServer, app) {
  // ── REST ────────────────────────────────────────────────────────────
  app.post('/api/messenger/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Unsupported or missing file' });
    res.json({
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname,
      size: req.file.size,
      mimeType: req.file.mimetype,
    });
  });

  // ── Phone sign-in ───────────────────────────────────────────────────
  app.post('/api/auth/request-code', async (req, res) => {
    const { dialCode, number } = req.body || {};
    const phone = store.normalizePhone(dialCode, number);
    if (!phone) return res.status(400).json({ error: 'Enter a valid phone number' });

    const issued = store.issueCode(phone);
    if (issued.error) return res.status(429).json({ error: issued.error, retryAfter: issued.retryAfter });

    const sent = await sms.sendCode(phone, issued.code);
    if (sent.error) return res.status(502).json({ error: sent.error });

    const existing = store.findUserByPhone(phone);
    res.json({
      phone,
      registered: Boolean(existing),
      username: existing?.username || null,
      delivered: sent.delivered,
      // In dev mode (no Twilio configured) the code comes back so you can sign in.
      devCode: sent.devCode,
    });
  });

  app.post('/api/auth/verify', (req, res) => {
    const { phone, code, username, avatar } = req.body || {};
    // The client echoes back the exact E.164 string we returned from request-code.
    const target = String(phone || '').trim();
    if (!/^\+\d{7,15}$/.test(target)) return res.status(400).json({ error: 'Unknown number' });

    const check = store.verifyCode(target, code);
    if (check.error) return res.status(401).json({ error: check.error });

    const existing = store.findUserByPhone(target);
    // A brand-new number must supply a display name before it gets an account.
    if (!existing && (!username || String(username).trim().length < 2)) {
      return res.json({ needsProfile: true, phone: target });
    }

    const user = store.upsertUserByPhone(target, { username, avatar });
    store.consumePhoneVerification(target);
    const token = store.createSession(user.id);
    res.json({ token, user: store.publicUser(user) });
  });

  // Completes sign-up for a number that just verified but had no profile yet.
  app.post('/api/auth/register', (req, res) => {
    const { phone, username, avatar } = req.body || {};
    const target = String(phone || '').trim();
    if (!store.isPhoneVerified(target)) {
      return res.status(401).json({ error: 'Verify your number again' });
    }
    if (!username || String(username).trim().length < 2) {
      return res.status(400).json({ error: 'Name must be at least 2 characters' });
    }
    const user = store.upsertUserByPhone(target, { username, avatar });
    store.consumePhoneVerification(target);
    const token = store.createSession(user.id);
    res.json({ token, user: store.publicUser(user) });
  });

  app.post('/api/auth/session', (req, res) => {
    const user = store.userForSession((req.body || {}).token);
    if (!user) return res.status(401).json({ error: 'Session expired' });
    res.json({ user: store.publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    store.destroySession((req.body || {}).token);
    res.json({ ok: true });
  });

  app.get('/api/messenger/users', (_req, res) => res.json(store.getAllUsers()));

  app.get('/api/messenger/chats', (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json(store.getUserChats(userId));
  });

  app.get('/api/messenger/messages/:chatId', (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json(store.getMessages(req.params.chatId, userId, parseInt(req.query.limit) || 200));
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  // ── Socket.io ───────────────────────────────────────────────────────
  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1e7,
  });

  /** Push a user's whole chat list to every device they have open. */
  const pushChats = (userId) => {
    const user = store.getUser(userId);
    if (!user) return;
    const chats = store.getUserChats(userId);
    for (const sid of user.socketIds) io.to(sid).emit('chats:list', chats);
  };

  /** Push chat list refresh to all members of a chat. */
  const pushChatsToMembers = (chatId) => {
    const chat = store.getChat(chatId);
    if (!chat) return;
    for (const memberId of chat.members) pushChats(memberId);
  };

  const emitToUser = (userId, event, payload) => {
    const user = store.getUser(userId);
    if (!user) return;
    for (const sid of user.socketIds) io.to(sid).emit(event, payload);
  };

  const broadcastPresence = () => {
    io.emit('presence:update', store.getAllUsers().map(u => ({
      id: u.id, status: u.status, lastSeen: u.lastSeen,
    })));
  };

  io.on('connection', (socket) => {
    // ── Join / identify ───────────────────────────────────────────────
    socket.on('user:join', ({ token }, ack) => {
      const user = store.userForSession(token);
      if (!user) return ack?.({ error: 'Session expired', signedOut: true });

      store.attachSocket(user.id, socket.id);
      socket.data.userId = user.id;

      for (const chat of store.getUserChats(user.id)) socket.join(chat.id);
      socket.join(`user:${user.id}`);

      // Anything that arrived while offline is now "delivered".
      const touched = store.markAllDelivered(user.id);
      for (const { chatId, ids } of touched) {
        socket.to(chatId).emit('messages:delivered', { chatId, messageIds: ids, userId: user.id });
      }

      ack?.({
        user: store.publicUser(user),
        chats: store.getUserChats(user.id),
        users: store.getAllUsers(),
      });

      socket.emit('chats:list', store.getUserChats(user.id));
      io.emit('users:list', store.getAllUsers());
      broadcastPresence();
    });

    const me = () => (socket.data.userId ? store.getUser(socket.data.userId) : null);

    // ── Profile ───────────────────────────────────────────────────────
    socket.on('profile:update', (payload, ack) => {
      const user = me();
      if (!user) return;
      const result = store.updateProfile(user.id, payload || {});
      if (result?.error) return ack?.({ error: result.error });
      ack?.({ user: result.user });
      io.emit('users:list', store.getAllUsers());
      for (const chat of store.getUserChats(user.id)) pushChatsToMembers(chat.id);
    });

    // ── Send message ──────────────────────────────────────────────────
    socket.on('message:send', ({ chatId, text, file, type, replyTo, tempId }, ack) => {
      const user = me();
      if (!user) return;
      const chat = store.getChat(chatId);
      if (!chat || !chat.members.has(user.id)) return ack?.({ error: 'Chat not found' });
      if (!String(text || '').trim() && !file) return;

      const raw = store.addMessage({
        chatId,
        senderId: user.id,
        text: String(text || '').trim(),
        file,
        type,
        replyTo,
      });

      // Mark delivered for every member who currently has a live socket.
      for (const memberId of chat.members) {
        const m = store.getUser(memberId);
        if (m && m.socketIds.size > 0) raw.deliveredTo.add(memberId);
      }
      store.save();

      ack?.({ tempId, message: store.outMessage(raw, user.id) });

      for (const memberId of chat.members) {
        emitToUser(memberId, 'message:new', store.outMessage(raw, memberId));
        pushChats(memberId);
      }
    });

    // ── Edit / delete / react ─────────────────────────────────────────
    socket.on('message:edit', ({ chatId, messageId, text }) => {
      const user = me();
      if (!user) return;
      const raw = store.editMessage(chatId, messageId, user.id, String(text || '').trim());
      if (!raw) return;
      const chat = store.getChat(chatId);
      for (const memberId of chat.members) {
        emitToUser(memberId, 'message:updated', store.outMessage(raw, memberId));
        pushChats(memberId);
      }
    });

    socket.on('message:delete', ({ chatId, messageId, forEveryone }) => {
      const user = me();
      if (!user) return;
      const raw = store.deleteMessage(chatId, messageId, user.id, forEveryone);
      if (!raw) return;
      const chat = store.getChat(chatId);
      if (forEveryone) {
        for (const memberId of chat.members) {
          emitToUser(memberId, 'message:updated', store.outMessage(raw, memberId));
          pushChats(memberId);
        }
      } else {
        emitToUser(user.id, 'message:removed', { chatId, messageId });
        pushChats(user.id);
      }
    });

    socket.on('message:react', ({ chatId, messageId, emoji }) => {
      const user = me();
      if (!user) return;
      const raw = store.toggleReaction(chatId, messageId, user.id, emoji);
      if (!raw) return;
      const chat = store.getChat(chatId);
      for (const memberId of chat.members) {
        emitToUser(memberId, 'message:updated', store.outMessage(raw, memberId));
      }
    });

    // ── Receipts ──────────────────────────────────────────────────────
    socket.on('messages:read', ({ chatId }) => {
      const user = me();
      if (!user) return;
      const ids = store.markRead(chatId, user.id);
      if (ids.length) {
        socket.to(chatId).emit('messages:read', { chatId, messageIds: ids, userId: user.id });
        const chat = store.getChat(chatId);
        if (chat) for (const memberId of chat.members) pushChats(memberId);
      } else {
        pushChats(user.id);
      }
    });

    // ── Typing ────────────────────────────────────────────────────────
    socket.on('typing:start', ({ chatId }) => {
      const user = me();
      if (!user) return;
      socket.to(chatId).emit('typing:start', { chatId, userId: user.id, username: user.username });
    });

    socket.on('typing:stop', ({ chatId }) => {
      const user = me();
      if (!user) return;
      socket.to(chatId).emit('typing:stop', { chatId, userId: user.id });
    });

    // ── Chats ─────────────────────────────────────────────────────────
    socket.on('chat:createGroup', ({ name, members, about }, ack) => {
      const user = me();
      if (!user) return;
      const all = [...new Set([user.id, ...(members || [])])];
      const chat = store.createChat({
        name: String(name || 'New group').trim(),
        type: 'group',
        about,
        members: all,
        createdBy: user.id,
      });

      store.addMessage({
        chatId: chat.id,
        senderId: user.id,
        text: `${user.username} created group "${chat.name}"`,
        type: 'system',
      });

      for (const memberId of all) {
        const m = store.getUser(memberId);
        if (m) for (const sid of m.socketIds) io.sockets.sockets.get(sid)?.join(chat.id);
        emitToUser(memberId, 'chat:new', store.chatView(chat, memberId));
        pushChats(memberId);
      }
      ack?.({ chat: store.chatView(chat, user.id) });
    });

    socket.on('chat:startDM', ({ targetUserId }, ack) => {
      const user = me();
      if (!user || targetUserId === user.id) return;
      const chat = store.findOrCreateDM(user.id, targetUserId);
      for (const memberId of chat.members) {
        const m = store.getUser(memberId);
        if (m) for (const sid of m.socketIds) io.sockets.sockets.get(sid)?.join(chat.id);
        emitToUser(memberId, 'chat:new', store.chatView(chat, memberId));
        pushChats(memberId);
      }
      ack?.({ chat: store.chatView(chat, user.id) });
    });

    socket.on('chat:open', ({ chatId }, ack) => {
      const user = me();
      if (!user) return;
      const chat = store.getChat(chatId);
      if (!chat || !chat.members.has(user.id)) return ack?.({ error: 'Chat not found' });
      socket.join(chatId);
      const ids = store.markRead(chatId, user.id);
      if (ids.length) socket.to(chatId).emit('messages:read', { chatId, messageIds: ids, userId: user.id });
      ack?.({ chat: store.chatView(chat, user.id), messages: store.getMessages(chatId, user.id) });
      pushChatsToMembers(chatId);
    });

    socket.on('chat:flag', ({ chatId, flag, value }) => {
      const user = me();
      if (!user) return;
      if (!['pinned', 'muted', 'archived'].includes(flag)) return;
      store.setChatFlag(user.id, chatId, flag, !!value);
      pushChats(user.id);
    });

    socket.on('chat:clear', ({ chatId }) => {
      const user = me();
      if (!user) return;
      store.clearChat(user.id, chatId);
      emitToUser(user.id, 'chat:cleared', { chatId });
      pushChats(user.id);
    });

    socket.on('chat:leave', ({ chatId }) => {
      const user = me();
      if (!user || chatId === store.GENERAL_ROOM_ID) return;
      const chat = store.getChat(chatId);
      if (!chat) return;
      const remaining = [...chat.members].filter(id => id !== user.id);
      if (chat.type === 'group') {
        store.addMessage({
          chatId, senderId: user.id, type: 'system',
          text: `${user.username} left the group`,
        });
      }
      store.leaveChat(user.id, chatId);
      socket.leave(chatId);
      emitToUser(user.id, 'chat:removed', { chatId });
      pushChats(user.id);
      for (const memberId of remaining) {
        emitToUser(memberId, 'chats:refresh', { chatId });
        pushChats(memberId);
      }
    });

    socket.on('chat:addMembers', ({ chatId, members }) => {
      const user = me();
      if (!user) return;
      const chat = store.getChat(chatId);
      if (!chat || chat.type !== 'group') return;
      for (const id of members || []) {
        if (chat.members.has(id)) continue;
        store.joinChat(id, chatId);
        const m = store.getUser(id);
        store.addMessage({
          chatId, senderId: user.id, type: 'system',
          text: `${user.username} added ${m ? m.username : 'someone'}`,
        });
        if (m) for (const sid of m.socketIds) io.sockets.sockets.get(sid)?.join(chatId);
      }
      for (const memberId of chat.members) {
        emitToUser(memberId, 'chat:new', store.chatView(chat, memberId));
        pushChats(memberId);
      }
    });

    socket.on('search:messages', ({ query }, ack) => {
      const user = me();
      if (!user) return;
      ack?.(store.searchMessages(user.id, query));
    });

    // ── Disconnect ────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const userId = socket.data.userId;
      if (!userId) return;
      const wentOffline = store.detachSocket(userId, socket.id);
      if (wentOffline) {
        io.emit('users:list', store.getAllUsers());
        broadcastPresence();
      }
    });
  });

  return io;
}

module.exports = { attach };
