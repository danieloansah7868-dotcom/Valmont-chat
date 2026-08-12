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
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { rateLimit } = require('express-rate-limit');
const store = require('./messenger-store');
const sms = require('./sms');
const {
  authFromRequest, authRequired, tokenFromRequest,
  setSessionCookie, clearSessionCookie, requestMetadata,
} = require('./http-auth');

// Media is deliberately outside /public. Every download passes through an
// authenticated membership check below.
const UPLOAD_DIR = process.env.VCHAT_MEDIA_DIR || path.join(store.DATA_DIR, 'media');
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });

const SAFE_MIME = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|quicktime|webm)|audio\/(mpeg|wav|ogg|webm|mp4|x-m4a)|application\/(pdf|zip|msword|vnd\.(openxmlformats-officedocument|ms-excel|ms-powerpoint))|text\/(plain|csv))$/i;
const protectedDiskStorage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
    callback(null, `${crypto.randomUUID()}${extension}`);
  },
});
const upload = multer({
  storage: protectedDiskStorage,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, SAFE_MIME.test(file.mimetype)),
});
const profileUpload = multer({
  storage: protectedDiskStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, /^image\/(jpeg|png|webp)$/i.test(file.mimetype)),
});

function detectedImageMime(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(12);
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (bytesRead >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytesRead >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF'
    && header.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** Only server-issued attachment IDs may be posted into messages. */
function cleanFile(file, ownerId, chatId) {
  if (!file || typeof file !== 'object') return null;
  const out = store.validateAttachment(String(file.id || ''), ownerId, chatId);
  if (!out) return null;
  if (file.voice) {
    out.voice = true;
    out.duration = Math.max(0, Math.min(300, Math.round(Number(file.duration) || 0)));
  }
  return out;
}

/**
 * Live calls, keyed by id. Purely in-memory: a call cannot outlive the process
 * that is relaying its signalling, so there is nothing worth persisting.
 *
 *   { id, chatId, from, to, media, state, startedAt, answeredAt, timer }
 */
const calls = new Map();

/** Find whatever call a user is currently tied up in. */
function callForUser(userId) {
  for (const c of calls.values()) {
    // A privacy-silenced unknown call must not make the recipient appear busy.
    if (c.from === userId || (c.to === userId && !c.silent)) return c;
  }
  return null;
}

const RING_TIMEOUT_MS = 45000;

// A call is dropped from `calls` the moment it ends, but the rating prompt
// appears *after* that. Keep a small receipt around so we can still check the
// person rating a call was actually on it.
const recentCalls = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;

function rememberCall(call, outcome) {
  recentCalls.set(call.id, {
    id: call.id,
    chatId: call.chatId,
    from: call.from,
    to: call.to,
    media: call.media,
    outcome,
    duration: call.answeredAt ? Math.round((Date.now() - call.answeredAt) / 1000) : 0,
    endedAt: Date.now(),
  });
  const t = setTimeout(() => recentCalls.delete(call.id), RATE_WINDOW_MS);
  if (t.unref) t.unref();
}

function attach(httpServer, app) {
  // ── REST and authentication ────────────────────────────────────────
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.AUTH_RATE_LIMIT || 20),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });

  app.post('/api/auth/request-code', authLimiter, async (req, res) => {
    const { dialCode, number } = req.body || {};
    const phone = store.normalizePhone(dialCode, number);
    if (!phone) return res.status(400).json({ error: 'Enter a valid phone number' });
    const issued = store.issueCode(phone);
    if (issued.error) return res.status(429).json({ error: issued.error, retryAfter: issued.retryAfter });
    const sent = await sms.sendCode(phone, issued.code);
    if (sent.error) return res.status(502).json({ error: sent.error });
    const existing = store.findUserByPhone(phone);
    return res.json({
      phone,
      registered: Boolean(existing),
      username: existing?.username || null,
      delivered: sent.delivered,
      // Only the no-provider development transport returns this field.
      devCode: sent.devCode,
    });
  });

  app.post('/api/auth/verify', authLimiter, (req, res) => {
    const { phone, code, username, avatar } = req.body || {};
    const target = String(phone || '').trim();
    if (!/^\+\d{7,15}$/.test(target)) return res.status(400).json({ error: 'Unknown number' });
    const check = store.verifyCode(target, code);
    if (check.error) return res.status(401).json({ error: check.error });
    const existing = store.findUserByPhone(target);
    if (existing?.pinHash) return res.json({ needsTwoStep: true, phone: target });
    if (!existing && (!username || String(username).trim().length < 2)) {
      return res.json({ needsProfile: true, phone: target });
    }
    const user = store.upsertUserByPhone(target, { username, avatar });
    store.consumePhoneVerification(target);
    const token = store.createSession(user.id, requestMetadata(req));
    setSessionCookie(res, token);
    return res.json({ user: store.accountView(user) });
  });

  app.post('/api/auth/two-step', authLimiter, (req, res) => {
    const target = String(req.body?.phone || '').trim();
    const user = store.findUserByPhone(target);
    if (!user || !store.isPhoneVerified(target) || !store.verifyTwoStepPin(user, req.body?.pin)) {
      return res.status(401).json({ error: 'Incorrect two-step verification PIN' });
    }
    store.consumePhoneVerification(target);
    const token = store.createSession(user.id, requestMetadata(req));
    setSessionCookie(res, token);
    return res.json({ user: store.accountView(user) });
  });

  app.post('/api/auth/register', authLimiter, (req, res) => {
    const { phone, username, avatar } = req.body || {};
    const target = String(phone || '').trim();
    if (!store.isPhoneVerified(target)) return res.status(401).json({ error: 'Verify your number again' });
    if (store.findUserByPhone(target)) return res.status(409).json({ error: 'This account already exists' });
    if (!username || String(username).trim().length < 2) {
      return res.status(400).json({ error: 'Name must be at least 2 characters' });
    }
    const user = store.upsertUserByPhone(target, { username, avatar });
    store.consumePhoneVerification(target);
    const token = store.createSession(user.id, requestMetadata(req));
    setSessionCookie(res, token);
    return res.json({ user: store.accountView(user) });
  });

  app.get('/api/auth/session', authRequired, (req, res) => res.json({ user: store.accountView(req.auth.user) }));
  // Compatibility with older shells during service-worker upgrades. The body token is ignored.
  app.post('/api/auth/session', authRequired, (req, res) => res.json({ user: store.accountView(req.auth.user) }));

  app.post('/api/auth/logout', (req, res) => {
    const auth = authFromRequest(req);
    const token = tokenFromRequest(req);
    if (token) store.destroySession(token);
    if (auth) disconnectInvalidSockets(auth.user.id);
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  app.get('/api/account/devices', authRequired, (req, res) => {
    res.json(store.listSessions(req.auth.user.id, req.auth.token));
  });
  app.delete('/api/account/devices/:sessionId', authRequired, (req, res) => {
    const devices = store.listSessions(req.auth.user.id, req.auth.token);
    const target = devices.find(device => device.id === req.params.sessionId);
    if (!target) return res.status(404).json({ error: 'Device not found' });
    if (target.current) return res.status(400).json({ error: 'Sign out from the current device using Log out' });
    store.revokeSession(req.auth.user.id, target.id);
    disconnectInvalidSockets(req.auth.user.id);
    return res.json({ ok: true });
  });
  app.delete('/api/account/devices', authRequired, (req, res) => {
    const revoked = store.revokeOtherSessions(req.auth.user.id, req.auth.token);
    disconnectInvalidSockets(req.auth.user.id);
    res.json({ ok: true, revoked });
  });
  app.patch('/api/account/privacy', authRequired, (req, res) => {
    const privacy = store.updatePrivacy(req.auth.user.id, req.body || {});
    pushUsers();
    res.json({ privacy });
  });
  app.put('/api/account/profile-photo', authRequired, (req, res, next) => {
    profileUpload.single('photo')(req, res, error => {
      if (error) return next(error);
      if (!req.file) return res.status(400).json({ error: 'Choose a JPEG, PNG, or WebP image up to 5 MB' });
      let detectedMime;
      try {
        detectedMime = detectedImageMime(req.file.path);
      } catch (readError) {
        fs.unlink(req.file.path, () => {});
        return next(readError);
      }
      if (detectedMime !== String(req.file.mimetype).toLowerCase()) {
        fs.unlink(req.file.path, () => {});
        return res.status(415).json({ error: 'The uploaded file is not a valid JPEG, PNG, or WebP image' });
      }
      let result;
      try {
        result = store.setProfilePhoto(req.auth.user.id, {
          storageName: req.file.filename,
          mime: detectedMime,
        });
      } catch (saveError) {
        fs.unlink(req.file.path, () => {});
        return next(saveError);
      }
      if (!result) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Could not save profile photo' });
      }
      if (result.previous?.storageName) {
        fs.unlink(path.join(UPLOAD_DIR, path.basename(result.previous.storageName)), () => {});
      }
      pushUsers();
      return res.json({ user: result.user });
    });
  });
  app.delete('/api/account/profile-photo', authRequired, (req, res) => {
    const result = store.clearProfilePhoto(req.auth.user.id);
    if (!result) return res.status(404).json({ error: 'Account not found' });
    if (result.previous?.storageName) {
      fs.unlink(path.join(UPLOAD_DIR, path.basename(result.previous.storageName)), () => {});
    }
    pushUsers();
    return res.json({ user: result.user });
  });
  app.put('/api/account/two-step', authRequired, (req, res) => {
    if (req.auth.user.pinHash && !store.verifyTwoStepPin(req.auth.user, req.body?.currentPin)) {
      return res.status(401).json({ error: 'Current PIN is incorrect' });
    }
    if (!store.setTwoStepPin(req.auth.user.id, req.body?.pin)) {
      return res.status(400).json({ error: 'PIN must contain exactly 6 digits' });
    }
    const revokedSessions = store.revokeOtherSessions(req.auth.user.id, req.auth.token);
    disconnectInvalidSockets(req.auth.user.id);
    return res.json({ ok: true, revokedSessions });
  });
  app.delete('/api/account/two-step', authRequired, (req, res) => {
    if (!req.auth.user.pinHash || !store.verifyTwoStepPin(req.auth.user, req.body?.pin)) {
      return res.status(401).json({ error: 'Current PIN is incorrect' });
    }
    store.clearTwoStepPin(req.auth.user.id);
    const revokedSessions = store.revokeOtherSessions(req.auth.user.id, req.auth.token);
    disconnectInvalidSockets(req.auth.user.id);
    return res.json({ ok: true, revokedSessions });
  });
  app.post('/api/account/block/:targetId', authRequired, (req, res) => {
    const blocked = req.body?.blocked !== false;
    if (!store.blockUser(req.auth.user.id, req.params.targetId, blocked)) {
      return res.status(400).json({ error: 'Unable to update block list' });
    }
    return res.json({ ok: true, blocked });
  });
  app.post('/api/account/report/:targetId', authRequired, (req, res) => {
    const report = store.reportUser(req.auth.user.id, req.params.targetId, req.body?.reason, req.body?.chatId);
    if (!report) return res.status(400).json({ error: 'Unable to submit report' });
    return res.status(201).json({ ok: true, report });
  });

  app.get('/api/messenger/users', authRequired, (req, res) => {
    res.json(store.getAllUsers(req.auth.user.id));
  });
  app.get('/api/messenger/chats', authRequired, (req, res) => {
    res.json(store.getUserChats(req.auth.user.id));
  });
  app.get('/api/messenger/messages/:chatId', authRequired, (req, res) => {
    const chat = store.getChat(req.params.chatId);
    if (!chat?.members.has(req.auth.user.id)) return res.status(404).json({ error: 'Chat not found' });
    return res.json(store.getMessages(chat.id, req.auth.user.id, Number(req.query.limit) || 200));
  });

  app.post('/api/messenger/upload', authRequired, (req, res, next) => {
    upload.single('file')(req, res, error => {
      if (error) return next(error);
      if (!req.file) return res.status(400).json({ error: 'Unsupported or missing file' });
      const attachment = store.registerAttachment({
        ownerId: req.auth.user.id,
        chatId: String(req.body?.chatId || ''),
        storageName: req.file.filename,
        name: req.file.originalname,
        mime: req.file.mimetype,
        size: req.file.size,
      });
      if (!attachment) {
        fs.unlink(req.file.path, () => {});
        return res.status(403).json({ error: 'Upload must belong to one of your chats' });
      }
      return res.status(201).json({
        id: attachment.id,
        url: `/api/messenger/media/${encodeURIComponent(attachment.id)}`,
        name: attachment.name,
        size: attachment.size,
        mimeType: attachment.mime,
      });
    });
  });

  app.get('/api/messenger/profile-photo/:userId', authRequired, (req, res) => {
    const owner = store.getUser(req.params.userId);
    const projected = owner && store.publicUser(owner, req.auth.user.id);
    if (!owner?.profilePhoto || !projected?.photoUrl) return res.status(404).json({ error: 'Profile photo not found' });
    const filePath = path.join(UPLOAD_DIR, path.basename(owner.profilePhoto.storageName));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Profile photo unavailable' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', owner.profilePhoto.mime);
    res.setHeader('Content-Disposition', 'inline');
    return res.sendFile(filePath);
  });

  app.get('/api/messenger/media/:attachmentId', authRequired, (req, res) => {
    const attachment = store.getAttachment(req.params.attachmentId, req.auth.user.id);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    const filePath = path.join(UPLOAD_DIR, path.basename(attachment.storageName));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Attachment unavailable' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', attachment.mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
    return res.sendFile(filePath);
  });

  app.get('/api/calls/ice', authRequired, (req, res) => {
    const urls = String(process.env.TURN_URLS || '').split(',').map(value => value.trim()).filter(Boolean);
    const secret = process.env.TURN_SECRET;
    const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
    if (urls.length && secret) {
      const username = `${Math.floor(Date.now() / 1000) + 3600}:${req.auth.user.id}`;
      const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
      iceServers.push({ urls, username, credential });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ iceServers, expiresIn: 3600, turnConfigured: Boolean(urls.length && secret) });
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  // ── Socket.io ───────────────────────────────────────────────────────
  const io = new Server(httpServer, {
    cors: {
      origin(origin, callback) { callback(null, true); },
      methods: ['GET', 'POST'],
      credentials: true,
    },
    allowRequest(req, callback) {
      callback(null, app.locals.isOriginAllowed(req.headers.origin, req.headers.host));
    },
    maxHttpBufferSize: 1e6,
    perMessageDeflate: false,
  });

  io.use((socket, next) => {
    const auth = authFromRequest(socket.request);
    if (!auth) return next(new Error('Authentication required'));
    socket.data.userId = auth.user.id;
    socket.data.sessionToken = auth.token;
    return next();
  });

  function disconnectInvalidSockets(userId) {
    const user = store.getUser(userId);
    if (!user) return;
    for (const socketId of [...user.socketIds]) {
      const activeSocket = io.sockets.sockets.get(socketId);
      if (activeSocket && !store.userForSession(activeSocket.data.sessionToken)) {
        activeSocket.emit('session:revoked');
        activeSocket.disconnect(true);
      }
    }
  }

  const pushChats = (userId) => {
    const user = store.getUser(userId);
    if (!user) return;
    const chatList = store.getUserChats(userId);
    for (const socketId of user.socketIds) io.to(socketId).emit('chats:list', chatList);
  };

  const pushChatsToMembers = (chatId) => {
    const chat = store.getChat(chatId);
    if (!chat) return;
    for (const memberId of chat.members) pushChats(memberId);
  };

  const emitToUser = (userId, event, payload) => {
    const user = store.getUser(userId);
    if (!user) return;
    for (const socketId of user.socketIds) io.to(socketId).emit(event, payload);
  };

  // Privacy projections differ per viewer, so user/presence lists are never
  // emitted as one globally shared payload.
  const pushUsers = () => {
    for (const viewer of store.getAllUsers()) {
      const user = store.getUser(viewer.id);
      if (!user?.socketIds.size) continue;
      const projected = store.getAllUsers(user.id);
      for (const socketId of user.socketIds) io.to(socketId).emit('users:list', projected);
    }
  };

  const broadcastPresence = () => {
    for (const viewer of store.getAllUsers()) {
      const user = store.getUser(viewer.id);
      if (!user?.socketIds.size) continue;
      const presence = store.getAllUsers(user.id).map(item => ({
        id: item.id, status: item.status, lastSeen: item.lastSeen,
      }));
      for (const socketId of user.socketIds) io.to(socketId).emit('presence:update', presence);
    }
  };

  io.on('connection', (socket) => {
    const user = store.getUser(socket.data.userId);
    if (!user) return socket.disconnect(true);
    store.attachSocket(user.id, socket.id);
    for (const chat of store.getUserChats(user.id)) socket.join(chat.id);
    socket.join(`user:${user.id}`);

    const touched = store.markAllDelivered(user.id);
    for (const { chatId, ids } of touched) {
      socket.to(chatId).emit('messages:delivered', { chatId, messageIds: ids, userId: user.id });
    }
    socket.emit('chats:list', store.getUserChats(user.id));
    pushUsers();
    broadcastPresence();

    const me = () => {
      const activeUser = store.userForSession(socket.data.sessionToken);
      if (!activeUser) {
        socket.emit('session:revoked');
        socket.disconnect(true);
        return null;
      }
      return activeUser;
    };

    // Kept as an initialization acknowledgement for older clients. Identity
    // is already fixed by the HttpOnly session cookie before connection.
    socket.on('user:join', (_payload, ack) => {
      const activeUser = me();
      if (!activeUser) return ack?.({ error: 'Authentication required' });
      ack?.({
        user: store.accountView(activeUser),
        chats: store.getUserChats(activeUser.id),
        users: store.getAllUsers(activeUser.id),
      });
    });

    // ── Profile ───────────────────────────────────────────────────────
    socket.on('profile:update', (payload, ack) => {
      const user = me();
      if (!user) return;
      const result = store.updateProfile(user.id, payload || {});
      if (result?.error) return ack?.({ error: result.error });
      ack?.({ user: result.user });
      pushUsers();
      for (const chat of store.getUserChats(user.id)) pushChatsToMembers(chat.id);
    });

    // ── Send message ──────────────────────────────────────────────────
    socket.on('message:send', ({ chatId, text, file, type, replyTo, tempId, clientId }, ack) => {
      const user = me();
      if (!user) return;
      const chat = store.getChat(chatId);
      if (!chat || !chat.members.has(user.id)) return ack?.({ error: 'Chat not found' });
      if (!store.canPerform(chat, user.id, 'sendMessages')) return ack?.({ error: 'Only admins can send messages here' });
      if (chat.type === 'dm') {
        const peerId = [...chat.members].find(id => id !== user.id);
        if (peerId && store.isBlockedBetween(user.id, peerId)) return ack?.({ error: 'Messaging is unavailable for this chat' });
      }
      const body = String(text || '').trim().slice(0, 10000);
      const safeFile = cleanFile(file, user.id, chatId);
      if (!body && !safeFile) return ack?.({ error: 'Message is empty or the attachment is invalid' });
      const reply = replyTo && store.getRawMessage(chatId, String(replyTo.id || replyTo)) ? replyTo : null;

      // A sender that lost signal mid-send retries with the same clientId.
      // Acknowledge the copy we already have rather than posting it twice.
      const already = store.findByClientId(chatId, user.id, clientId);
      if (already) {
        return ack?.({ tempId, duplicate: true, message: store.outMessage(already, user.id) });
      }

      const raw = store.addMessage({
        chatId,
        senderId: user.id,
        text: body,
        file: safeFile,
        type,
        replyTo: reply,
        clientId: typeof clientId === 'string' ? clientId.slice(0, 64) : null,
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
      const chat = store.getChat(chatId);
      if (!user || !chat?.members.has(user.id)) return;
      const raw = store.editMessage(chatId, messageId, user.id, String(text || '').trim().slice(0, 10000));
      if (!raw) return;
      for (const memberId of chat.members) {
        emitToUser(memberId, 'message:updated', store.outMessage(raw, memberId));
        pushChats(memberId);
      }
    });

    socket.on('message:delete', ({ chatId, messageId, forEveryone }) => {
      const user = me();
      const chat = store.getChat(chatId);
      if (!user || !chat?.members.has(user.id)) return;
      const raw = store.deleteMessage(chatId, messageId, user.id, !!forEveryone);
      if (!raw) return;
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
      const chat = store.getChat(chatId);
      if (!user || !chat?.members.has(user.id)) return;
      const allowedEmoji = String(emoji || '').slice(0, 16);
      if (!allowedEmoji) return;
      const raw = store.toggleReaction(chatId, messageId, user.id, allowedEmoji);
      if (!raw) return;
      for (const memberId of chat.members) {
        emitToUser(memberId, 'message:updated', store.outMessage(raw, memberId));
      }
    });

    socket.on('message:star', ({ chatId, messageId }, ack) => {
      const user = me();
      const chat = store.getChat(chatId);
      if (!user || !chat?.members.has(user.id)) return ack?.({ error: 'Chat not found' });
      const raw = store.toggleStar(chatId, messageId, user.id);
      if (!raw) return ack?.({ error: 'Message not found' });
      const message = store.outMessage(raw, user.id);
      emitToUser(user.id, 'message:updated', message);
      return ack?.({ message });
    });

    socket.on('message:pin', ({ chatId, messageId, durationSeconds }, ack) => {
      const user = me();
      const raw = user && store.pinMessage(chatId, messageId, user.id, durationSeconds);
      if (!raw) return ack?.({ error: 'Only group admins can pin messages here' });
      const chat = store.getChat(chatId);
      for (const memberId of chat.members) emitToUser(memberId, 'message:updated', store.outMessage(raw, memberId));
      return ack?.({ ok: true });
    });

    socket.on('message:forward', ({ chatId, messageId, targetChatIds }, ack) => {
      const user = me();
      if (!user) return ack?.({ error: 'Not signed in' });
      const source = store.getChat(chatId);
      if (source?.advancedPrivacy) return ack?.({ error: 'Forwarding is disabled by advanced chat privacy' });
      const forwarded = store.forwardMessage(chatId, messageId, user.id, targetChatIds);
      for (const raw of forwarded) {
        const target = store.getChat(raw.chatId);
        for (const memberId of target.members) {
          emitToUser(memberId, 'message:new', store.outMessage(raw, memberId));
          pushChats(memberId);
        }
      }
      return ack?.({ ok: true, count: forwarded.length });
    });

    // ── Receipts ──────────────────────────────────────────────────────
    socket.on('messages:read', ({ chatId }) => {
      const user = me();
      const chat = store.getChat(chatId);
      if (!user || !chat?.members.has(user.id)) return;
      const shareReceipt = chat.type === 'group' || user.privacy?.readReceipts !== false;
      const ids = store.markRead(chatId, user.id, shareReceipt);
      if (ids.length) {
        socket.to(chatId).emit('messages:read', { chatId, messageIds: ids, userId: user.id });
        for (const memberId of chat.members) pushChats(memberId);
      } else {
        pushChats(user.id);
      }
    });

    // ── Typing ────────────────────────────────────────────────────────
    socket.on('typing:start', ({ chatId }) => {
      const user = me();
      const chat = store.getChat(chatId);
      if (!user || !chat?.members.has(user.id)) return;
      socket.to(chatId).emit('typing:start', { chatId, userId: user.id, username: user.username });
    });

    socket.on('typing:stop', ({ chatId }) => {
      const user = me();
      const chat = store.getChat(chatId);
      if (!user || !chat?.members.has(user.id)) return;
      socket.to(chatId).emit('typing:stop', { chatId, userId: user.id });
    });

    // ── Chats ─────────────────────────────────────────────────────────
    socket.on('chat:createGroup', ({ name, members, about }, ack) => {
      const user = me();
      if (!user) return ack?.({ error: 'Not signed in' });
      const all = [...new Set([user.id, ...(Array.isArray(members) ? members : [])])]
        .filter(id => store.getUser(id))
        .slice(0, 1024);
      const groupName = String(name || '').trim().slice(0, 100);
      if (!groupName) return ack?.({ error: 'Group name is required' });
      const chat = store.createChat({
        name: groupName,
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
      if (!user || targetUserId === user.id || !store.getUser(targetUserId)) return ack?.({ error: 'Contact not found' });
      if (store.isBlockedBetween(user.id, targetUserId)) return ack?.({ error: 'Messaging is unavailable for this contact' });
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
      const shareReceipt = chat.type === 'group' || user.privacy?.readReceipts !== false;
      const ids = store.markRead(chatId, user.id, shareReceipt);
      if (ids.length) socket.to(chatId).emit('messages:read', { chatId, messageIds: ids, userId: user.id });
      ack?.({ chat: store.chatView(chat, user.id), messages: store.getMessages(chatId, user.id) });
      pushChatsToMembers(chatId);
    });

    socket.on('chat:flag', ({ chatId, flag, value }) => {
      const user = me();
      if (!user) return;
      if (!['pinned', 'favorite', 'muted', 'archived', 'manualUnread'].includes(flag)) return;
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

    socket.on('chat:setDisappearing', ({ chatId, seconds }, ack) => {
      const user = me();
      const chat = user && store.setDisappearing(chatId, user.id, seconds);
      if (!chat) return ack?.({ error: 'Only group admins can change this setting' });
      const label = chat.disappearingSeconds ? `${Math.round(chat.disappearingSeconds / 86400)} day(s)` : 'off';
      const raw = store.addMessage({ chatId, senderId: user.id, type: 'system', text: `${user.username} set disappearing messages to ${label}` });
      for (const memberId of chat.members) {
        emitToUser(memberId, 'message:new', store.outMessage(raw, memberId));
        pushChats(memberId);
      }
      return ack?.({ chat: store.chatView(chat, user.id) });
    });

    socket.on('chat:setAdvancedPrivacy', ({ chatId, enabled }, ack) => {
      const user = me();
      const chat = user && store.setAdvancedPrivacy(chatId, user.id, enabled);
      if (!chat) return ack?.({ error: 'Only group admins can change this setting' });
      const raw = store.addMessage({
        chatId, senderId: user.id, type: 'system',
        text: `${user.username} turned advanced chat privacy ${chat.advancedPrivacy ? 'on' : 'off'}`,
      });
      for (const memberId of chat.members) {
        emitToUser(memberId, 'message:new', store.outMessage(raw, memberId));
        pushChats(memberId);
      }
      return ack?.({ chat: store.chatView(chat, user.id) });
    });

    socket.on('chat:createInvite', ({ chatId }, ack) => {
      const user = me();
      const code = user && store.createInvite(chatId, user.id);
      if (!code) return ack?.({ error: 'Only admins can create an invite link' });
      return ack?.({ code, path: `/?invite=${encodeURIComponent(code)}` });
    });

    socket.on('chat:revokeInvites', ({ chatId }, ack) => {
      const user = me();
      const ok = user && store.revokeInvites(chatId, user.id);
      return ack?.(ok ? { ok: true } : { error: 'Only admins can reset the invite link' });
    });

    socket.on('chat:joinInvite', ({ code }, ack) => {
      const user = me();
      const chat = user && store.joinByInvite(user.id, code);
      if (!chat) return ack?.({ error: 'This invite link is invalid or was reset' });
      socket.join(chat.id);
      for (const memberId of chat.members) {
        emitToUser(memberId, 'chat:new', store.chatView(chat, memberId));
        pushChats(memberId);
      }
      return ack?.({ chat: store.chatView(chat, user.id) });
    });

    socket.on('group:update', ({ chatId, ...patch }, ack) => {
      const user = me();
      const chat = user && store.updateGroup(chatId, user.id, patch);
      if (!chat) return ack?.({ error: 'You cannot change these group settings' });
      pushChatsToMembers(chatId);
      return ack?.({ chat: store.chatView(chat, user.id) });
    });

    socket.on('group:setAdmin', ({ chatId, memberId, makeAdmin }, ack) => {
      const user = me();
      const ok = user && store.setAdmin(chatId, user.id, memberId, !!makeAdmin);
      if (!ok) return ack?.({ error: 'Unable to change this participant role' });
      pushChatsToMembers(chatId);
      return ack?.({ ok: true });
    });

    socket.on('group:removeMember', ({ chatId, memberId }, ack) => {
      const user = me();
      const ok = user && store.removeMember(chatId, user.id, memberId);
      if (!ok) return ack?.({ error: 'Unable to remove this participant' });
      emitToUser(memberId, 'chat:removed', { chatId });
      pushChats(memberId);
      pushChatsToMembers(chatId);
      return ack?.({ ok: true });
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

    socket.on('chat:addMembers', ({ chatId, members }, ack) => {
      const user = me();
      if (!user) return ack?.({ error: 'Not signed in' });
      const chat = store.getChat(chatId);
      if (!chat || chat.type !== 'group' || !store.canPerform(chat, user.id, 'addMembers')) {
        return ack?.({ error: 'Only admins can add participants' });
      }
      for (const id of (Array.isArray(members) ? members : []).slice(0, 1024 - chat.members.size)) {
        if (!store.getUser(id)) continue;
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
      return ack?.({ ok: true });
    });

    socket.on('search:messages', ({ query }, ack) => {
      const user = me();
      if (!user) return;
      ack?.(store.searchMessages(user.id, query));
    });

    // ── Voice / video calls ───────────────────────────────────────────
    //
    // The server only carries signalling. Audio and video go peer to peer
    // over WebRTC and never touch this process.

    /** Write the call into the conversation, the way WhatsApp logs one. */
    const logCall = (call, outcome) => {
      const secs = call.answeredAt ? Math.round((Date.now() - call.answeredAt) / 1000) : 0;
      const raw = store.addMessage({
        chatId: call.chatId,
        senderId: call.from,
        text: '',
        type: 'call',
        call: { media: call.media, outcome, duration: secs, from: call.from },
      });
      const chat = store.getChat(call.chatId);
      if (!chat) return;
      for (const memberId of chat.members) {
        emitToUser(memberId, 'message:new', store.outMessage(raw, memberId));
        pushChats(memberId);
      }
    };

    /** Tear a call down once, telling everyone still attached to it. */
    const closeCall = (call, { outcome, except = null, reason = null }) => {
      if (!calls.has(call.id)) return;
      clearTimeout(call.timer);
      calls.delete(call.id);
      rememberCall(call, outcome);
      // Only a call that actually connected is worth rating.
      const rateable = !!call.answeredAt;
      for (const uid of [call.from, call.to]) {
        if (uid === except) continue;
        emitToUser(uid, 'call:ended', { callId: call.id, reason, rateable });
      }
      if (outcome) logCall(call, outcome);
    };

    socket.on('call:start', ({ chatId, media }, ack) => {
      const user = me();
      if (!user) return ack?.({ error: 'Not signed in' });

      const chat = store.getChat(chatId);
      if (!chat || !chat.members.has(user.id)) return ack?.({ error: 'Chat not found' });
      // Group calls need a media server to mix streams; one-to-one only for now.
      if (chat.type !== 'dm') return ack?.({ error: 'Calls are one-to-one only' });

      const peerId = [...chat.members].find(id => id !== user.id);
      const peer = peerId && store.getUser(peerId);
      if (!peer) return ack?.({ error: 'Nobody to call' });
      if (store.isBlockedBetween(user.id, peer.id)) return ack?.({ error: 'Calling is unavailable for this contact' });

      if (callForUser(user.id)) return ack?.({ error: 'You are already on a call' });
      if (!peer.socketIds.size) return ack?.({ error: `${peer.username} is offline` });
      if (callForUser(peer.id)) return ack?.({ error: `${peer.username} is on another call` });

      const silent = peer.privacy?.silenceUnknownCallers !== false && !store.isKnownContact(peer.id, user.id);
      const call = {
        id: uuid(),
        chatId,
        from: user.id,
        to: peer.id,
        media: media === 'video' ? 'video' : 'audio',
        silent,
        state: 'ringing',
        startedAt: Date.now(),
        answeredAt: null,
        timer: null,
      };
      calls.set(call.id, call);

      // Nobody picked up.
      call.timer = setTimeout(() => {
        if (calls.get(call.id)?.state === 'ringing') {
          closeCall(call, { outcome: 'missed', reason: 'timeout' });
        }
      }, RING_TIMEOUT_MS);

      // Unknown callers still hear normal ringing and leave a missed-call log,
      // but a recipient who enabled call silencing receives no ringing event.
      if (!silent) {
        emitToUser(peer.id, 'call:incoming', {
          callId: call.id,
          chatId,
          media: call.media,
          from: store.publicUser(user, peer.id),
        });
      }

      ack?.({ callId: call.id, peer: store.publicUser(peer, user.id), media: call.media });
    });

    socket.on('call:accept', ({ callId }) => {
      const user = me();
      const call = calls.get(callId);
      if (!user || !call || call.to !== user.id || call.state !== 'ringing') return;
      call.state = 'active';
      call.answeredAt = Date.now();
      clearTimeout(call.timer);
      // The caller creates the offer once the callee has actually accepted.
      emitToUser(call.from, 'call:accepted', { callId });
    });

    socket.on('call:decline', ({ callId }) => {
      const user = me();
      const call = calls.get(callId);
      if (!user || !call || call.to !== user.id) return;
      closeCall(call, { outcome: 'declined', except: user.id, reason: 'declined' });
    });

    socket.on('call:cancel', ({ callId }) => {
      const user = me();
      const call = calls.get(callId);
      if (!user || !call || call.from !== user.id) return;
      closeCall(call, { outcome: 'missed', except: user.id, reason: 'cancelled' });
    });

    socket.on('call:end', ({ callId }) => {
      const user = me();
      const call = calls.get(callId);
      if (!user || !call || (call.from !== user.id && call.to !== user.id)) return;
      const outcome = call.answeredAt ? 'ended' : (call.from === user.id ? 'missed' : 'declined');
      closeCall(call, { outcome, except: user.id, reason: 'ended' });
    });

    /** Blind relay for SDP and ICE. The server never inspects the payload. */
    socket.on('call:signal', ({ callId, data }) => {
      const user = me();
      const call = calls.get(callId);
      if (!user || !call || !data || typeof data !== 'object') return;
      if (call.from !== user.id && call.to !== user.id) return;
      if (JSON.stringify(data).length > 100000) return;
      const other = call.from === user.id ? call.to : call.from;
      emitToUser(other, 'call:signal', { callId, data });
    });

    socket.on('call:rate', ({ callId, stars, tags, note }, ack) => {
      const user = me();
      if (!user) return ack?.({ error: 'Not signed in' });

      const past = recentCalls.get(callId);
      if (!past) return ack?.({ error: 'That call is no longer open for feedback' });
      if (past.from !== user.id && past.to !== user.id) return ack?.({ error: 'You were not on that call' });
      if (store.hasRated(callId, user.id)) return ack?.({ error: 'You already rated this call' });

      const rating = store.rateCall({
        callId,
        userId: user.id,
        chatId: past.chatId,
        media: past.media,
        duration: past.duration,
        stars, tags, note,
      });
      if (!rating) return ack?.({ error: 'Pick a rating between 1 and 5 stars' });
      ack?.({ ok: true, stars: rating.stars });
    });

    /** Your own call-quality history — what you reported and how it trends. */
    socket.on('call:ratings', (_payload, ack) => {
      const user = me();
      if (!user) return ack?.({ error: 'Not signed in' });
      ack?.(store.ratingSummary({ userId: user.id }));
    });

    // ── Disconnect ────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const userId = socket.data.userId;
      if (!userId) return;

      // Dropping the last tab while on a call hangs it up for the other side.
      const call = callForUser(userId);
      if (call) {
        const user = store.getUser(userId);
        const lastDevice = user && user.socketIds.size <= 1;
        if (lastDevice) {
          const outcome = call.answeredAt ? 'ended' : 'missed';
          closeCall(call, { outcome, except: userId, reason: 'disconnected' });
        }
      }

      const wentOffline = store.detachSocket(userId, socket.id);
      if (wentOffline) {
        pushUsers();
        broadcastPresence();
      }
    });
  });

  const pruneTimer = setInterval(() => {
    for (const item of store.pruneExpiredMessages()) {
      io.to(item.chatId).emit('message:removed', { chatId: item.chatId, messageId: item.messageId, expired: true });
      pushChatsToMembers(item.chatId);
    }
  }, 30 * 1000);
  pruneTimer.unref?.();
  httpServer.once('close', () => clearInterval(pruneTimer));

  return io;
}

module.exports = { attach };
