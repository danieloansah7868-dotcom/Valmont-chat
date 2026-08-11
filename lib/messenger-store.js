/**
 * VChat store — users, chats and messages.
 *
 * Everything lives in memory for speed and is mirrored to data/db.json
 * (debounced) so a server restart doesn't wipe the conversation history.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// key: userId → { id, username, avatar, color, about, status, lastSeen, socketIds:Set }
const users = new Map();
// key: chatId → { id, name, type:'group'|'dm', members:Set, createdAt, createdBy, about, avatar }
const chats = new Map();
// key: chatId → [ message ]
const messagesByChat = new Map();
// key: `${userId}:${chatId}` → { lastReadAt, archived, pinned, muted, cleared }
const chatState = new Map();
// key: phone (E.164) → { hash, salt, expiresAt, attempts, sentAt, sendCount, windowStart }
const pendingCodes = new Map();
// key: token → { userId, createdAt }
const sessions = new Map();
// key: phone → expiresAt — numbers that passed verification but have no profile yet
const verifiedPhones = new Map();
// key: `${callId}:${userId}` → { callId, userId, chatId, media, stars, tags, note, duration, at }
const callRatings = new Map();

const GENERAL_ROOM_ID = 'general';
// How far back a retry is recognised as a duplicate rather than a new message.
const CLIENT_ID_WINDOW_MS = 24 * 60 * 60 * 1000;

const AVATAR_COLORS = [
  '#00a884', '#53bdeb', '#7f66ff', '#f2a33c', '#e542a3',
  '#25d366', '#ff6b6b', '#0088cc', '#b06bff', '#f15c6d',
];

// ── Persistence ────────────────────────────────────────────────────────
let saveTimer = null;

function serialize() {
  return {
    users: [...users.values()].map(u => ({
      ...u, socketIds: undefined, status: 'offline',
    })),
    chats: [...chats.values()].map(c => ({ ...c, members: [...c.members] })),
    messages: [...messagesByChat.entries()].map(([chatId, list]) => [
      chatId,
      list.map(m => ({
        ...m,
        readBy: [...m.readBy],
        deliveredTo: [...m.deliveredTo],
        deletedFor: [...m.deletedFor],
      })),
    ]),
    chatState: [...chatState.entries()],
    sessions: [...sessions.entries()],
    callRatings: [...callRatings.entries()],
  };
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(serialize()), 'utf8');
    } catch (err) {
      console.error('[store] save failed:', err.message);
    }
  }, 400);
  if (saveTimer.unref) saveTimer.unref();
}

function load() {
  try {
    if (!fs.existsSync(DB_FILE)) return false;
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    for (const u of raw.users || []) {
      users.set(u.id, { ...u, socketIds: new Set(), status: 'offline' });
    }
    for (const c of raw.chats || []) {
      chats.set(c.id, { ...c, members: new Set(c.members || []) });
    }
    for (const [chatId, list] of raw.messages || []) {
      messagesByChat.set(chatId, (list || []).map(m => ({
        ...m,
        readBy: new Set(m.readBy || []),
        deliveredTo: new Set(m.deliveredTo || []),
        deletedFor: new Set(m.deletedFor || []),
        reactions: m.reactions || {},
      })));
    }
    for (const [k, v] of raw.chatState || []) chatState.set(k, v);
    for (const [k, v] of raw.sessions || []) sessions.set(k, v);
    for (const [k, v] of raw.callRatings || []) callRatings.set(k, v);
    return true;
  } catch (err) {
    console.error('[store] load failed:', err.message);
    return false;
  }
}

load();

if (!chats.has(GENERAL_ROOM_ID)) {
  chats.set(GENERAL_ROOM_ID, {
    id: GENERAL_ROOM_ID,
    name: 'Valmont General',
    type: 'group',
    about: 'Everyone lands here. Say hi 👋',
    members: new Set(),
    createdAt: Date.now(),
    createdBy: null,
  });
  messagesByChat.set(GENERAL_ROOM_ID, []);
}

// ── Helpers ────────────────────────────────────────────────────────────
const norm = s => String(s || '').trim().toLowerCase();

function stateKey(userId, chatId) { return `${userId}:${chatId}`; }

function getState(userId, chatId) {
  const key = stateKey(userId, chatId);
  if (!chatState.has(key)) {
    chatState.set(key, { lastReadAt: 0, archived: false, pinned: false, muted: false, clearedAt: 0 });
  }
  return chatState.get(key);
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    phone: u.phone || null,
    username: u.username,
    avatar: u.avatar || null,
    color: u.color,
    about: u.about || 'Hey there! I am using VChat.',
    status: u.status,
    lastSeen: u.lastSeen,
  };
}

// ── Phone numbers & verification codes ─────────────────────────────────
const CODE_TTL_MS = 5 * 60 * 1000;   // a code is valid for 5 minutes
const MAX_ATTEMPTS = 5;              // wrong guesses before the code dies
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_SENDS_PER_HOUR = 5;

/**
 * Normalise a dial code + local number into E.164 (+233201234567).
 * Strips spaces, dashes, brackets and a leading 0 on the local part.
 */
function normalizePhone(dialCode, localNumber) {
  const cc = String(dialCode || '').replace(/[^\d]/g, '');
  let local = String(localNumber || '').replace(/[^\d]/g, '');
  if (!cc || !local) return null;
  local = local.replace(/^0+/, '');            // 020… → 20…
  if (local.length < 6 || local.length > 14) return null;
  const full = `+${cc}${local}`;
  if (full.length > 16) return null;
  return full;
}

function findUserByPhone(phone) {
  for (const u of users.values()) if (u.phone === phone) return u;
  return null;
}

const hashCode = (code, salt) =>
  crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');

/**
 * Create (or refuse to re-create) a verification code for a number.
 * @returns {{code}|{error, retryAfter?}}
 */
function issueCode(phone) {
  const now = Date.now();
  const prev = pendingCodes.get(phone);

  // Throttle resends and cap how many codes an hour a number can request.
  let sendCount = 0;
  let windowStart = now;
  if (prev) {
    if (now - prev.sentAt < RESEND_COOLDOWN_MS) {
      return { error: 'Please wait before requesting another code', retryAfter: Math.ceil((RESEND_COOLDOWN_MS - (now - prev.sentAt)) / 1000) };
    }
    if (now - prev.windowStart < 60 * 60 * 1000) {
      if (prev.sendCount >= MAX_SENDS_PER_HOUR) {
        return { error: 'Too many codes requested for this number. Try again later.' };
      }
      sendCount = prev.sendCount;
      windowStart = prev.windowStart;
    }
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = crypto.randomBytes(8).toString('hex');
  pendingCodes.set(phone, {
    hash: hashCode(code, salt),
    salt,
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
    sentAt: now,
    sendCount: sendCount + 1,
    windowStart,
  });
  return { code };
}

/**
 * Check a submitted code. Consumes the pending code on success.
 * @returns {{ok:true}|{error:string}}
 */
function verifyCode(phone, code) {
  const rec = pendingCodes.get(phone);
  if (!rec) return { error: 'Request a code first' };
  if (Date.now() > rec.expiresAt) {
    pendingCodes.delete(phone);
    return { error: 'That code has expired. Request a new one.' };
  }
  if (rec.attempts >= MAX_ATTEMPTS) {
    pendingCodes.delete(phone);
    return { error: 'Too many incorrect attempts. Request a new code.' };
  }

  const given = String(code || '').replace(/[^\d]/g, '');
  const expected = rec.hash;
  const actual = hashCode(given, rec.salt);
  const match = given.length === 6 &&
    crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));

  if (!match) {
    rec.attempts += 1;
    const left = MAX_ATTEMPTS - rec.attempts;
    return { error: left > 0 ? `Incorrect code — ${left} attempt${left === 1 ? '' : 's'} left` : 'Too many incorrect attempts. Request a new code.' };
  }

  pendingCodes.delete(phone);
  verifiedPhones.set(phone, Date.now() + 10 * 60 * 1000);
  return { ok: true };
}

/** True when `phone` recently passed verification and may still register. */
function isPhoneVerified(phone) {
  const exp = verifiedPhones.get(phone);
  if (!exp) return false;
  if (Date.now() > exp) { verifiedPhones.delete(phone); return false; }
  return true;
}

function consumePhoneVerification(phone) { verifiedPhones.delete(phone); }

/** Register a phone user, or return the existing account for that number. */
function upsertUserByPhone(phone, { username, avatar, about } = {}) {
  let user = findUserByPhone(phone);
  if (!user) {
    const id = uuidv4();
    user = {
      id,
      phone,
      username: (username && String(username).trim()) || phone,
      avatar: avatar || null,
      color: AVATAR_COLORS[users.size % AVATAR_COLORS.length],
      about: about || 'Hey there! I am using VChat.',
      status: 'online',
      lastSeen: Date.now(),
      createdAt: Date.now(),
      socketIds: new Set(),
    };
    users.set(id, user);
    joinChat(id, GENERAL_ROOM_ID);
  } else {
    if (username) user.username = String(username).trim();
    if (avatar) user.avatar = avatar;
    if (about) user.about = about;
    user.status = 'online';
  }
  save();
  return user;
}

// ── Sessions ───────────────────────────────────────────────────────────
function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId, createdAt: Date.now() });
  save();
  return token;
}

function userForSession(token) {
  const rec = sessions.get(String(token || ''));
  if (!rec) return null;
  return users.get(rec.userId) || null;
}

function destroySession(token) {
  if (sessions.delete(String(token || ''))) save();
}

// ── Users ──────────────────────────────────────────────────────────────
function findUserByName(username) {
  for (const u of users.values()) if (norm(u.username) === norm(username)) return u;
  return null;
}

function upsertUser({ username, avatar, about }) {
  let user = findUserByName(username);
  if (!user) {
    const id = uuidv4();
    user = {
      id,
      username: String(username).trim(),
      avatar: avatar || null,
      color: AVATAR_COLORS[users.size % AVATAR_COLORS.length],
      about: about || 'Hey there! I am using VChat.',
      status: 'online',
      lastSeen: Date.now(),
      socketIds: new Set(),
    };
    users.set(id, user);
    joinChat(id, GENERAL_ROOM_ID);
  } else {
    if (avatar) user.avatar = avatar;
    if (about) user.about = about;
    user.status = 'online';
  }
  save();
  return user;
}

function getUser(userId) { return users.get(userId) || null; }

function getUserBySocket(socketId) {
  for (const u of users.values()) if (u.socketIds.has(socketId)) return u;
  return null;
}

function attachSocket(userId, socketId) {
  const u = users.get(userId);
  if (!u) return;
  u.socketIds.add(socketId);
  u.status = 'online';
  u.lastSeen = Date.now();
}

function detachSocket(userId, socketId) {
  const u = users.get(userId);
  if (!u) return false;
  u.socketIds.delete(socketId);
  if (u.socketIds.size === 0) {
    u.status = 'offline';
    u.lastSeen = Date.now();
    save();
    return true; // fully offline
  }
  return false;
}

function updateProfile(userId, { username, avatar, about }) {
  const u = users.get(userId);
  if (!u) return null;
  if (username && norm(username) !== norm(u.username)) {
    const clash = findUserByName(username);
    if (clash && clash.id !== userId) return { error: 'That name is already taken' };
    u.username = String(username).trim();
  }
  if (avatar !== undefined) u.avatar = avatar;
  if (about !== undefined) u.about = about;
  save();
  return { user: publicUser(u) };
}

function getAllUsers() { return [...users.values()].map(publicUser); }
function getOnlineUsers() { return [...users.values()].filter(u => u.status === 'online').map(publicUser); }

// ── Chats ──────────────────────────────────────────────────────────────
function createChat({ name, type, members, createdBy, about }) {
  const id = uuidv4();
  const chat = {
    id,
    name: name || 'New chat',
    type: type || 'group',
    about: about || '',
    members: new Set(members || []),
    createdAt: Date.now(),
    createdBy: createdBy || null,
  };
  chats.set(id, chat);
  messagesByChat.set(id, []);
  save();
  return chat;
}

function getChat(chatId) { return chats.get(chatId) || null; }

function joinChat(userId, chatId) {
  const chat = chats.get(chatId);
  if (chat) { chat.members.add(userId); save(); }
  return chat;
}

function leaveChat(userId, chatId) {
  const chat = chats.get(chatId);
  if (!chat) return;
  chat.members.delete(userId);
  if (chat.members.size === 0 && chat.id !== GENERAL_ROOM_ID) {
    chats.delete(chatId);
    messagesByChat.delete(chatId);
  }
  save();
}

function findOrCreateDM(a, b) {
  for (const chat of chats.values()) {
    if (chat.type === 'dm' && chat.members.has(a) && chat.members.has(b)) return chat;
  }
  return createChat({ name: 'Direct message', type: 'dm', members: [a, b], createdBy: a });
}

function lastVisibleMessage(chatId, userId) {
  const list = messagesByChat.get(chatId) || [];
  const st = getState(userId, chatId);
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.timestamp <= (st.clearedAt || 0)) break;
    if (m.deletedFor.has(userId)) continue;
    return m;
  }
  return null;
}

function unreadCount(chatId, userId) {
  const list = messagesByChat.get(chatId) || [];
  const st = getState(userId, chatId);
  let n = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.timestamp <= st.lastReadAt) break;
    if (m.senderId === userId || m.deletedFor.has(userId)) continue;
    n++;
  }
  return n;
}

/** Chat shaped for the sidebar of a given user. */
function chatView(chat, userId) {
  const last = lastVisibleMessage(chat.id, userId);
  const st = getState(userId, chat.id);
  const members = [...chat.members];
  let name = chat.name;
  let peer = null;
  if (chat.type === 'dm') {
    const otherId = members.find(m => m !== userId) || userId;
    peer = publicUser(users.get(otherId));
    name = peer ? peer.username : 'Unknown';
  }
  return {
    id: chat.id,
    type: chat.type,
    name,
    about: chat.about || '',
    members,
    peer,
    createdAt: chat.createdAt,
    createdBy: chat.createdBy,
    lastMessage: last ? outMessage(last, userId) : null,
    unread: unreadCount(chat.id, userId),
    pinned: !!st.pinned,
    muted: !!st.muted,
    archived: !!st.archived,
  };
}

function getUserChats(userId) {
  const out = [];
  for (const chat of chats.values()) {
    if (chat.members.has(userId)) out.push(chatView(chat, userId));
  }
  out.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastMessage?.timestamp || b.createdAt) - (a.lastMessage?.timestamp || a.createdAt);
  });
  return out;
}

function setChatFlag(userId, chatId, flag, value) {
  const st = getState(userId, chatId);
  st[flag] = value;
  save();
  return st;
}

function clearChat(userId, chatId) {
  const st = getState(userId, chatId);
  st.clearedAt = Date.now();
  save();
}

// ── Messages ───────────────────────────────────────────────────────────
function outMessage(m, viewerId) {
  const sender = users.get(m.senderId);
  return {
    id: m.id,
    chatId: m.chatId,
    senderId: m.senderId,
    clientId: m.clientId || null,
    sender: sender ? { id: sender.id, username: sender.username, avatar: sender.avatar, color: sender.color } : null,
    text: m.deleted ? '' : m.text,
    file: m.deleted ? null : m.file,
    call: m.call || null,
    type: m.type,
    timestamp: m.timestamp,
    editedAt: m.editedAt || null,
    deleted: !!m.deleted,
    replyTo: m.deleted ? null : m.replyTo || null,
    reactions: m.deleted ? {} : (m.reactions || {}),
    readBy: [...m.readBy],
    deliveredTo: [...m.deliveredTo],
    status: statusOf(m, viewerId),
  };
}

/** sent → delivered → read, computed against the other participants. */
function statusOf(m, viewerId) {
  if (m.senderId !== viewerId) return null;
  const chat = chats.get(m.chatId);
  if (!chat) return 'sent';
  const others = [...chat.members].filter(id => id !== m.senderId);
  if (others.length === 0) return 'sent';
  if (others.every(id => m.readBy.has(id))) return 'read';
  if (others.some(id => m.deliveredTo.has(id))) return 'delivered';
  return 'sent';
}

/**
 * Find a message this sender already stored under the same clientId.
 *
 * A phone that loses signal mid-send cannot tell whether the message landed,
 * so it retries. The clientId is how we recognise the second copy as the same
 * message and hand back the original instead of posting it twice. Only the
 * recent tail is searched — a retry is minutes old at worst.
 */
function findByClientId(chatId, senderId, clientId) {
  if (!clientId) return null;
  const list = messagesByChat.get(chatId) || [];
  const cutoff = Date.now() - CLIENT_ID_WINDOW_MS;
  for (let i = list.length - 1; i >= 0 && i >= list.length - 300; i--) {
    const m = list[i];
    if (m.timestamp < cutoff) break;
    if (m.senderId === senderId && m.clientId === clientId) return m;
  }
  return null;
}

function addMessage({ chatId, senderId, text, file, type, replyTo, call, clientId }) {
  const list = messagesByChat.get(chatId) || [];
  const msg = {
    id: uuidv4(),
    chatId,
    senderId,
    clientId: clientId || null,
    text: text || '',
    file: file || null,
    call: call || null,
    type: type || (file ? 'file' : 'text'),
    timestamp: Date.now(),
    editedAt: null,
    deleted: false,
    replyTo: replyTo || null,
    reactions: {},
    readBy: new Set([senderId]),
    deliveredTo: new Set([senderId]),
    deletedFor: new Set(),
  };
  list.push(msg);
  messagesByChat.set(chatId, list);
  save();
  return msg;
}

function getRawMessage(chatId, messageId) {
  return (messagesByChat.get(chatId) || []).find(m => m.id === messageId) || null;
}

function getMessages(chatId, userId, limit = 200) {
  const st = getState(userId, chatId);
  const list = (messagesByChat.get(chatId) || [])
    .filter(m => m.timestamp > (st.clearedAt || 0) && !m.deletedFor.has(userId));
  return list.slice(-limit).map(m => outMessage(m, userId));
}

function markDelivered(chatId, userId) {
  const changed = [];
  for (const m of messagesByChat.get(chatId) || []) {
    if (m.senderId !== userId && !m.deliveredTo.has(userId)) {
      m.deliveredTo.add(userId);
      changed.push(m.id);
    }
  }
  if (changed.length) save();
  return changed;
}

function markRead(chatId, userId) {
  const changed = [];
  for (const m of messagesByChat.get(chatId) || []) {
    if (m.senderId !== userId && !m.readBy.has(userId)) {
      m.readBy.add(userId);
      m.deliveredTo.add(userId);
      changed.push(m.id);
    }
  }
  const st = getState(userId, chatId);
  st.lastReadAt = Date.now();
  save();
  return changed;
}

function markAllDelivered(userId) {
  const touched = [];
  for (const chat of chats.values()) {
    if (!chat.members.has(userId)) continue;
    const ids = markDelivered(chat.id, userId);
    if (ids.length) touched.push({ chatId: chat.id, ids });
  }
  return touched;
}

function editMessage(chatId, messageId, userId, text) {
  const m = getRawMessage(chatId, messageId);
  if (!m || m.senderId !== userId || m.deleted) return null;
  m.text = text;
  m.editedAt = Date.now();
  save();
  return m;
}

function deleteMessage(chatId, messageId, userId, forEveryone) {
  const m = getRawMessage(chatId, messageId);
  if (!m) return null;
  if (forEveryone) {
    if (m.senderId !== userId) return null;
    m.deleted = true;
    m.text = '';
    m.file = null;
    m.reactions = {};
    m.replyTo = null;
  } else {
    m.deletedFor.add(userId);
  }
  save();
  return m;
}

function toggleReaction(chatId, messageId, userId, emoji) {
  const m = getRawMessage(chatId, messageId);
  if (!m || m.deleted) return null;
  m.reactions = m.reactions || {};
  const current = Object.keys(m.reactions).find(e => (m.reactions[e] || []).includes(userId));
  if (current) {
    m.reactions[current] = m.reactions[current].filter(id => id !== userId);
    if (!m.reactions[current].length) delete m.reactions[current];
  }
  if (current !== emoji) {
    m.reactions[emoji] = [...(m.reactions[emoji] || []), userId];
  }
  save();
  return m;
}

function searchMessages(userId, query) {
  const q = norm(query);
  if (!q) return [];
  const results = [];
  for (const chat of chats.values()) {
    if (!chat.members.has(userId)) continue;
    for (const m of messagesByChat.get(chat.id) || []) {
      if (m.deleted || m.deletedFor.has(userId)) continue;
      if (norm(m.text).includes(q)) {
        results.push({ chat: chatView(chat, userId), message: outMessage(m, userId) });
      }
    }
  }
  return results.sort((a, b) => b.message.timestamp - a.message.timestamp).slice(0, 50);
}
// ── Call quality ratings ───────────────────────────────────────────────
// Feedback is per person per call: both sides can rate the same call and
// each rating is written once. Ratings are never shown to the other party.

const RATING_TAGS = [
  'Audio was choppy',
  'Could not hear anything',
  'Video was frozen',
  'Video was blurry',
  'Audio and video out of sync',
  'Call dropped',
  'Echo or background noise',
  'Took too long to connect',
];

function rateCall({ callId, userId, chatId, media, stars, tags, note, duration }) {
  const n = Math.round(Number(stars));
  if (!callId || !userId || !Number.isFinite(n) || n < 1 || n > 5) return null;

  const key = `${callId}:${userId}`;
  if (callRatings.has(key)) return callRatings.get(key);   // one rating per person per call

  const clean = [...new Set(Array.isArray(tags) ? tags : [])]
    .filter(t => RATING_TAGS.includes(t))
    .slice(0, RATING_TAGS.length);

  const rating = {
    callId,
    userId,
    chatId: chatId || null,
    media: media === 'video' ? 'video' : 'audio',
    stars: n,
    tags: clean,
    note: String(note || '').trim().slice(0, 300),
    duration: Math.max(0, Math.round(Number(duration) || 0)),
    at: Date.now(),
  };
  callRatings.set(key, rating);
  save();
  return rating;
}

function hasRated(callId, userId) { return callRatings.has(`${callId}:${userId}`); }

function getCallRatings({ userId = null, since = null } = {}) {
  let list = [...callRatings.values()];
  if (userId) list = list.filter(r => r.userId === userId);
  if (since) list = list.filter(r => r.at >= since);
  return list.sort((a, b) => b.at - a.at);
}

/** Aggregate view for anyone who wants to know how calls are actually going. */
function ratingSummary({ userId = null, since = null } = {}) {
  const list = getCallRatings({ userId, since });
  const spread = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const tally = {};
  let total = 0;

  for (const r of list) {
    spread[r.stars]++;
    total += r.stars;
    for (const t of r.tags) tally[t] = (tally[t] || 0) + 1;
  }

  return {
    count: list.length,
    average: list.length ? Number((total / list.length).toFixed(2)) : null,
    spread,
    // What goes wrong most often, worst first.
    topIssues: Object.entries(tally)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count })),
    notes: list.filter(r => r.note).slice(0, 50).map(r => ({ stars: r.stars, note: r.note, at: r.at })),
  };
}

module.exports = {
  GENERAL_ROOM_ID,
  RATING_TAGS,
  AVATAR_COLORS,
  // users
  upsertUser, getUser, getUserBySocket, attachSocket, detachSocket,
  updateProfile, getAllUsers, getOnlineUsers, publicUser, findUserByName,
  // phone auth
  normalizePhone, findUserByPhone, issueCode, verifyCode, upsertUserByPhone,
  isPhoneVerified, consumePhoneVerification,
  createSession, userForSession, destroySession,
  // chats
  createChat, getChat, joinChat, leaveChat, findOrCreateDM, getUserChats,
  chatView, setChatFlag, clearChat, unreadCount,
  // messages
  addMessage, findByClientId, getMessages, getRawMessage, outMessage, markRead, markDelivered,
  markAllDelivered, editMessage, deleteMessage, toggleReaction, searchMessages,
  // call feedback
  rateCall, hasRated, getCallRatings, ratingSummary,
  save,
};
