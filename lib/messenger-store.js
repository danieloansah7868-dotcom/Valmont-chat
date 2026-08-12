'use strict';

/**
 * VChat transitional service store.
 *
 * Schema v2 is intentionally incompatible with the legacy plaintext snapshot.
 * Tokens are keyed by a SHA-256 digest, phone numbers never leave the account
 * boundary, media is indexed here and served through an authenticated route,
 * and message records can carry a versioned ciphertext envelope. PostgreSQL
 * replaces this adapter in the next infrastructure phase; this adapter keeps
 * local development and the security boundary deterministic in the meantime.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const SCHEMA_VERSION = 2;
const DATA_DIR = process.env.VCHAT_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.v2.json');
const LEGACY_FILE = path.join(DATA_DIR, 'db.json');
const GENERAL_ROOM_ID = 'general';
const CLIENT_ID_WINDOW_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;

const AVATAR_COLORS = [
  '#469f86', '#53bdeb', '#7f66ff', '#f2a33c', '#e542a3',
  '#c19052', '#ff6b6b', '#0088cc', '#b06bff', '#f15c6d',
];

const DEFAULT_PRIVACY = Object.freeze({
  lastSeen: 'contacts',
  profilePhoto: 'everyone',
  about: 'everyone',
  online: 'same-as-last-seen',
  readReceipts: true,
  silenceUnknownCallers: true,
  defaultDisappearingSeconds: 0,
  advancedChatPrivacy: false,
});

const users = new Map();
const chats = new Map();
const messagesByChat = new Map();
const chatState = new Map();
const pendingCodes = new Map();
// key is SHA-256(raw opaque cookie), never the cookie itself.
const sessions = new Map();
const verifiedPhones = new Map();
const callRatings = new Map();
const attachments = new Map();
const reports = [];
const inviteLinks = new Map();

const norm = value => String(value || '').trim().toLowerCase();
const tokenDigest = token => crypto.createHash('sha256').update(String(token || '')).digest('hex');
const stateKey = (userId, chatId) => `${userId}:${chatId}`;
const allowedAudience = new Set(['everyone', 'contacts', 'nobody']);

function defaultPrivacy(value = {}) {
  const merged = { ...DEFAULT_PRIVACY, ...(value || {}) };
  if (!allowedAudience.has(merged.lastSeen)) merged.lastSeen = DEFAULT_PRIVACY.lastSeen;
  if (!allowedAudience.has(merged.profilePhoto)) merged.profilePhoto = DEFAULT_PRIVACY.profilePhoto;
  if (!allowedAudience.has(merged.about)) merged.about = DEFAULT_PRIVACY.about;
  if (!['everyone', 'same-as-last-seen'].includes(merged.online)) merged.online = DEFAULT_PRIVACY.online;
  merged.readReceipts = merged.readReceipts !== false;
  merged.silenceUnknownCallers = merged.silenceUnknownCallers !== false;
  merged.advancedChatPrivacy = !!merged.advancedChatPrivacy;
  merged.defaultDisappearingSeconds = [0, 86400, 604800, 7776000]
    .includes(Number(merged.defaultDisappearingSeconds)) ? Number(merged.defaultDisappearingSeconds) : 0;
  return merged;
}

function getState(userId, chatId) {
  const key = stateKey(userId, chatId);
  if (!chatState.has(key)) {
    chatState.set(key, {
      lastReadAt: 0,
      archived: false,
      pinned: false,
      favorite: false,
      muted: false,
      manualUnread: false,
      clearedAt: 0,
    });
  }
  return chatState.get(key);
}

let saveTimer = null;

function serializeMessage(message) {
  return {
    ...message,
    readBy: [...message.readBy],
    deliveredTo: [...message.deliveredTo],
    deletedFor: [...message.deletedFor],
    starredBy: [...(message.starredBy || [])],
  };
}

function serialize() {
  return {
    schemaVersion: SCHEMA_VERSION,
    writtenAt: Date.now(),
    users: [...users.values()].map(user => ({
      ...user,
      socketIds: undefined,
      blocked: [...(user.blocked || [])],
      status: 'offline',
    })),
    chats: [...chats.values()].map(chat => ({
      ...chat,
      members: [...chat.members],
      admins: [...(chat.admins || [])],
    })),
    messages: [...messagesByChat.entries()].map(([chatId, list]) => [chatId, list.map(serializeMessage)]),
    chatState: [...chatState.entries()],
    // Session keys are already irreversible token digests.
    sessions: [...sessions.entries()],
    callRatings: [...callRatings.entries()],
    attachments: [...attachments.entries()],
    reports: reports.slice(-5000),
    inviteLinks: [...inviteLinks.entries()],
  };
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      const temp = `${DB_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(serialize()), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, DB_FILE);
    } catch (error) {
      console.error('[store] save failed:', error.message);
    }
  }, 250);
  saveTimer.unref?.();
}

function load() {
  try {
    // The user explicitly approved a secure reset. Never import schema-v1 data.
    if (!fs.existsSync(DB_FILE)) {
      if (fs.existsSync(LEGACY_FILE)) {
        console.warn('[store] legacy data/db.json was not imported; starting secure schema v2');
      }
      return false;
    }
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (raw.schemaVersion !== SCHEMA_VERSION) {
      console.warn(`[store] unsupported schema ${raw.schemaVersion}; starting clean schema v${SCHEMA_VERSION}`);
      return false;
    }
    for (const saved of raw.users || []) {
      users.set(saved.id, {
        ...saved,
        privacy: defaultPrivacy(saved.privacy),
        blocked: new Set(saved.blocked || []),
        socketIds: new Set(),
        status: 'offline',
      });
    }
    for (const saved of raw.chats || []) {
      chats.set(saved.id, {
        ...saved,
        members: new Set(saved.members || []),
        admins: new Set(saved.admins || (saved.createdBy ? [saved.createdBy] : [])),
        permissions: {
          editInfo: 'admins',
          sendMessages: 'members',
          addMembers: 'admins',
          ...(saved.permissions || {}),
        },
        advancedPrivacy: !!saved.advancedPrivacy,
      });
    }
    for (const [chatId, list] of raw.messages || []) {
      messagesByChat.set(chatId, (list || []).map(message => ({
        ...message,
        readBy: new Set(message.readBy || []),
        deliveredTo: new Set(message.deliveredTo || []),
        deletedFor: new Set(message.deletedFor || []),
        starredBy: new Set(message.starredBy || []),
        reactions: message.reactions || {},
      })));
    }
    for (const [key, value] of raw.chatState || []) chatState.set(key, value);
    const now = Date.now();
    for (const [digest, value] of raw.sessions || []) {
      if (value.expiresAt > now && users.has(value.userId)) sessions.set(digest, value);
    }
    for (const [key, value] of raw.callRatings || []) callRatings.set(key, value);
    for (const [key, value] of raw.attachments || []) attachments.set(key, value);
    for (const value of raw.reports || []) reports.push(value);
    for (const [key, value] of raw.inviteLinks || []) inviteLinks.set(key, value);
    return true;
  } catch (error) {
    console.error('[store] load failed:', error.message);
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
    admins: new Set(),
    permissions: { editInfo: 'admins', sendMessages: 'members', addMembers: 'admins' },
    disappearingSeconds: 0,
    advancedPrivacy: false,
    createdAt: Date.now(),
    createdBy: null,
  });
  messagesByChat.set(GENERAL_ROOM_ID, []);
}

// ── Privacy-aware user projection ─────────────────────────────────────

function usersShareChat(a, b) {
  if (!a || !b) return false;
  for (const chat of chats.values()) {
    // The public lobby is discovery, not proof that someone is in your contacts.
    if (chat.id !== GENERAL_ROOM_ID && chat.members.has(a) && chat.members.has(b)) return true;
  }
  return false;
}

/** An unsolicited DM does not make its sender a contact until the recipient replies. */
function isKnownContact(ownerId, otherId) {
  if (!ownerId || !otherId || ownerId === otherId) return false;
  for (const chat of chats.values()) {
    if (chat.id === GENERAL_ROOM_ID || !chat.members.has(ownerId) || !chat.members.has(otherId)) continue;
    if (chat.type === 'group' || chat.createdBy === ownerId) return true;
    if ((messagesByChat.get(chat.id) || []).some(message => message.senderId === ownerId && message.type !== 'system')) return true;
  }
  return false;
}

function audienceAllows(owner, viewerId, setting) {
  if (!viewerId || !owner) return setting === 'everyone';
  if (owner.id === viewerId) return true;
  if (owner.blocked?.has(viewerId)) return false;
  if (setting === 'everyone') return true;
  if (setting === 'contacts') return isKnownContact(owner.id, viewerId);
  return false;
}

function publicUser(user, viewerId = null) {
  if (!user) return null;
  const isSelf = user.id === viewerId;
  const privacy = defaultPrivacy(user.privacy);
  const showLastSeen = audienceAllows(user, viewerId, privacy.lastSeen);
  const showOnline = privacy.online === 'everyone' || showLastSeen;
  return {
    id: user.id,
    username: user.username,
    avatar: audienceAllows(user, viewerId, privacy.profilePhoto) ? (user.avatar || null) : null,
    photoUrl: audienceAllows(user, viewerId, privacy.profilePhoto) && user.profilePhoto
      ? `/api/messenger/profile-photo/${encodeURIComponent(user.id)}?v=${Number(user.profilePhoto.updatedAt) || 0}`
      : null,
    color: user.color,
    about: audienceAllows(user, viewerId, privacy.about) ? (user.about || 'Hey there! I am using VChat.') : '',
    status: showOnline ? user.status : 'private',
    lastSeen: showLastSeen ? user.lastSeen : null,
    blocked: isSelf ? [...(user.blocked || [])] : undefined,
  };
}

function accountView(user) {
  if (!user) return null;
  return {
    ...publicUser(user, user.id),
    phone: user.phone || null,
    privacy: defaultPrivacy(user.privacy),
    createdAt: user.createdAt,
    twoStepEnabled: !!user.pinHash,
  };
}

// ── Verification and accounts ─────────────────────────────────────────

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_SENDS_PER_HOUR = 5;

function normalizePhone(dialCode, localNumber) {
  const cc = String(dialCode || '').replace(/[^\d]/g, '');
  let local = String(localNumber || '').replace(/[^\d]/g, '');
  if (!cc || !local) return null;
  local = local.replace(/^0+/, '');
  if (local.length < 6 || local.length > 14) return null;
  const full = `+${cc}${local}`;
  return full.length <= 16 ? full : null;
}

function findUserByPhone(phone) {
  for (const user of users.values()) if (user.phone === phone) return user;
  return null;
}

const hashCode = (code, salt) => crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');

function issueCode(phone) {
  const now = Date.now();
  const previous = pendingCodes.get(phone);
  let sendCount = 0;
  let windowStart = now;
  if (previous) {
    if (now - previous.sentAt < RESEND_COOLDOWN_MS) {
      return {
        error: 'Please wait before requesting another code',
        retryAfter: Math.ceil((RESEND_COOLDOWN_MS - (now - previous.sentAt)) / 1000),
      };
    }
    if (now - previous.windowStart < 60 * 60 * 1000) {
      if (previous.sendCount >= MAX_SENDS_PER_HOUR) {
        return { error: 'Too many codes requested for this number. Try again later.' };
      }
      sendCount = previous.sendCount;
      windowStart = previous.windowStart;
    }
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = crypto.randomBytes(16).toString('hex');
  pendingCodes.set(phone, {
    hash: hashCode(code, salt), salt,
    expiresAt: now + CODE_TTL_MS,
    attempts: 0, sentAt: now,
    sendCount: sendCount + 1, windowStart,
  });
  return { code };
}

function verifyCode(phone, code) {
  const record = pendingCodes.get(phone);
  if (!record) return { error: 'Request a code first' };
  if (Date.now() > record.expiresAt) {
    pendingCodes.delete(phone);
    return { error: 'That code has expired. Request a new one.' };
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    pendingCodes.delete(phone);
    return { error: 'Too many incorrect attempts. Request a new code.' };
  }
  const given = String(code || '').replace(/[^\d]/g, '');
  const actual = hashCode(given, record.salt);
  const match = given.length === 6 && crypto.timingSafeEqual(
    Buffer.from(record.hash, 'hex'), Buffer.from(actual, 'hex'),
  );
  if (!match) {
    record.attempts += 1;
    const left = MAX_ATTEMPTS - record.attempts;
    return { error: left ? `Incorrect code — ${left} attempt${left === 1 ? '' : 's'} left` : 'Too many incorrect attempts. Request a new code.' };
  }
  pendingCodes.delete(phone);
  verifiedPhones.set(phone, Date.now() + 10 * 60 * 1000);
  return { ok: true };
}

function isPhoneVerified(phone) {
  const expiresAt = verifiedPhones.get(phone);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    verifiedPhones.delete(phone);
    return false;
  }
  return true;
}

function consumePhoneVerification(phone) { verifiedPhones.delete(phone); }

function makeUser({ phone = null, username, avatar = null, about = null }) {
  const id = uuidv4();
  const user = {
    id, phone,
    username: String(username || phone || 'VChat user').trim(),
    avatar,
    color: AVATAR_COLORS[users.size % AVATAR_COLORS.length],
    about: about || 'Hey there! I am using VChat.',
    privacy: defaultPrivacy(),
    blocked: new Set(),
    status: 'online',
    lastSeen: Date.now(),
    createdAt: Date.now(),
    socketIds: new Set(),
    pinHash: null,
    pinSalt: null,
  };
  users.set(id, user);
  joinChat(id, GENERAL_ROOM_ID);
  if (!chats.get(GENERAL_ROOM_ID).admins.size) chats.get(GENERAL_ROOM_ID).admins.add(id);
  return user;
}

function upsertUserByPhone(phone, { username, avatar, about } = {}) {
  let user = findUserByPhone(phone);
  if (!user) user = makeUser({ phone, username, avatar, about });
  else {
    if (username) user.username = String(username).trim();
    if (avatar !== undefined) user.avatar = avatar;
    if (about !== undefined) user.about = about;
    user.status = 'online';
  }
  save();
  return user;
}

function findUserByName(username) {
  for (const user of users.values()) if (norm(user.username) === norm(username)) return user;
  return null;
}

// Retained only for deterministic local/test helpers; public registration uses phone verification.
function upsertUser({ username, avatar, about }) {
  let user = findUserByName(username);
  if (!user) user = makeUser({ username, avatar, about });
  save();
  return user;
}

// ── Sessions and devices ──────────────────────────────────────────────

function createSession(userId, metadata = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const session = {
    id: uuidv4(), userId,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: now + SESSION_TTL_MS,
    label: String(metadata.label || 'Web browser').slice(0, 80),
    userAgent: String(metadata.userAgent || '').slice(0, 240),
    ipHint: String(metadata.ipHint || '').slice(0, 80),
  };
  sessions.set(tokenDigest(token), session);
  save();
  return token;
}

function sessionForToken(token) {
  const digest = tokenDigest(token);
  const session = sessions.get(digest);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(digest);
    save();
    return null;
  }
  session.lastUsedAt = Date.now();
  return session;
}

function userForSession(token) {
  const session = sessionForToken(token);
  return session ? (users.get(session.userId) || null) : null;
}

function destroySession(token) {
  const removed = sessions.delete(tokenDigest(token));
  if (removed) save();
  return removed;
}

function listSessions(userId, currentToken = null) {
  const currentDigest = currentToken ? tokenDigest(currentToken) : '';
  return [...sessions.entries()]
    .filter(([, session]) => session.userId === userId && session.expiresAt > Date.now())
    .map(([digest, session]) => ({ ...session, userId: undefined, current: digest === currentDigest }))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

function revokeSession(userId, sessionId) {
  for (const [digest, session] of sessions.entries()) {
    if (session.userId === userId && session.id === sessionId) {
      sessions.delete(digest);
      save();
      return true;
    }
  }
  return false;
}

function revokeOtherSessions(userId, currentToken) {
  const currentDigest = tokenDigest(currentToken);
  let count = 0;
  for (const [digest, session] of sessions.entries()) {
    if (session.userId === userId && digest !== currentDigest) {
      sessions.delete(digest);
      count += 1;
    }
  }
  if (count) save();
  return count;
}

// ── Users and safety settings ─────────────────────────────────────────

function getUser(userId) { return users.get(userId) || null; }

function getUserBySocket(socketId) {
  for (const user of users.values()) if (user.socketIds.has(socketId)) return user;
  return null;
}

function attachSocket(userId, socketId) {
  const user = users.get(userId);
  if (!user) return;
  user.socketIds.add(socketId);
  user.status = 'online';
  user.lastSeen = Date.now();
}

function detachSocket(userId, socketId) {
  const user = users.get(userId);
  if (!user) return false;
  user.socketIds.delete(socketId);
  if (!user.socketIds.size) {
    user.status = 'offline';
    user.lastSeen = Date.now();
    save();
    return true;
  }
  return false;
}

function updateProfile(userId, { username, avatar, about }) {
  const user = users.get(userId);
  if (!user) return null;
  if (username && norm(username) !== norm(user.username)) {
    const clash = findUserByName(username);
    if (clash && clash.id !== userId) return { error: 'That name is already taken' };
    user.username = String(username).trim().slice(0, 40);
  }
  if (avatar !== undefined) user.avatar = avatar;
  if (about !== undefined) user.about = String(about).slice(0, 140);
  save();
  return { user: accountView(user) };
}

function setProfilePhoto(userId, photo) {
  const user = users.get(userId);
  if (!user || !photo?.storageName || !photo?.mime) return null;
  const previous = user.profilePhoto || null;
  user.profilePhoto = {
    storageName: path.basename(String(photo.storageName)),
    mime: String(photo.mime),
    updatedAt: Date.now(),
  };
  save();
  return { previous, user: accountView(user) };
}

function clearProfilePhoto(userId) {
  const user = users.get(userId);
  if (!user) return null;
  const previous = user.profilePhoto || null;
  user.profilePhoto = null;
  save();
  return { previous, user: accountView(user) };
}

function updatePrivacy(userId, patch = {}) {
  const user = users.get(userId);
  if (!user) return null;
  user.privacy = defaultPrivacy({ ...user.privacy, ...patch });
  save();
  return user.privacy;
}

function setTwoStepPin(userId, pin) {
  const user = users.get(userId);
  const clean = String(pin || '').replace(/\D/g, '');
  if (!user || clean.length !== 6) return false;
  const salt = crypto.randomBytes(16);
  user.pinSalt = salt.toString('base64');
  user.pinHash = crypto.scryptSync(clean, salt, 32).toString('base64');
  save();
  return true;
}

function clearTwoStepPin(userId) {
  const user = users.get(userId);
  if (!user) return false;
  user.pinSalt = null;
  user.pinHash = null;
  save();
  return true;
}

function verifyTwoStepPin(user, pin) {
  if (!user?.pinHash || !user.pinSalt) return true;
  const candidate = crypto.scryptSync(String(pin || ''), Buffer.from(user.pinSalt, 'base64'), 32);
  return crypto.timingSafeEqual(Buffer.from(user.pinHash, 'base64'), candidate);
}

function blockUser(userId, targetId, blocked = true) {
  const user = users.get(userId);
  if (!user || !users.has(targetId) || userId === targetId) return false;
  if (blocked) user.blocked.add(targetId);
  else user.blocked.delete(targetId);
  save();
  return true;
}

function isBlockedBetween(a, b) {
  return !!(users.get(a)?.blocked?.has(b) || users.get(b)?.blocked?.has(a));
}

function reportUser(userId, targetId, reason = '', chatId = null) {
  if (!users.has(userId) || !users.has(targetId) || userId === targetId) return null;
  const report = {
    id: uuidv4(), reporterId: userId, targetId, chatId,
    reason: String(reason || 'spam').trim().slice(0, 500),
    createdAt: Date.now(), status: 'open',
  };
  reports.push(report);
  save();
  return { id: report.id, createdAt: report.createdAt };
}

function getAllUsers(viewerId = null) {
  return [...users.values()].map(user => publicUser(user, viewerId));
}

function getOnlineUsers(viewerId = null) {
  return [...users.values()].filter(user => user.status === 'online').map(user => publicUser(user, viewerId));
}

// ── Chats, group administration and invitations ──────────────────────

function createChat({ name, type, members, createdBy, about }) {
  const id = uuidv4();
  const creator = users.get(createdBy);
  const chat = {
    id,
    name: String(name || 'New chat').trim().slice(0, 100),
    type: type || 'group',
    about: String(about || '').slice(0, 500),
    members: new Set(members || []),
    admins: new Set(type === 'group' && createdBy ? [createdBy] : []),
    permissions: { editInfo: 'admins', sendMessages: 'members', addMembers: 'admins' },
    disappearingSeconds: type === 'dm' ? Number(creator?.privacy?.defaultDisappearingSeconds || 0) : 0,
    advancedPrivacy: !!creator?.privacy?.advancedChatPrivacy,
    createdAt: Date.now(),
    createdBy: createdBy || null,
  };
  chats.set(id, chat);
  messagesByChat.set(id, []);
  save();
  return chat;
}

function getChat(chatId) { return chats.get(chatId) || null; }

function canAdmin(chat, userId) { return chat?.type === 'group' && chat.admins?.has(userId); }

function canPerform(chat, userId, permission) {
  if (!chat?.members.has(userId)) return false;
  return chat.permissions?.[permission] !== 'admins' || canAdmin(chat, userId);
}

function joinChat(userId, chatId) {
  const chat = chats.get(chatId);
  if (chat) {
    chat.members.add(userId);
    save();
  }
  return chat;
}

function leaveChat(userId, chatId) {
  const chat = chats.get(chatId);
  if (!chat) return;
  chat.members.delete(userId);
  chat.admins?.delete(userId);
  if (chat.members.size && chat.type === 'group' && !chat.admins.size) {
    chat.admins.add([...chat.members][0]);
  }
  if (!chat.members.size && chat.id !== GENERAL_ROOM_ID) {
    chats.delete(chatId);
    messagesByChat.delete(chatId);
  }
  save();
}

function removeMember(chatId, actorId, memberId) {
  const chat = chats.get(chatId);
  if (!chat || !canAdmin(chat, actorId) || !chat.members.has(memberId) || actorId === memberId) return false;
  leaveChat(memberId, chatId);
  return true;
}

function setAdmin(chatId, actorId, memberId, makeAdmin) {
  const chat = chats.get(chatId);
  if (!chat || !canAdmin(chat, actorId) || !chat.members.has(memberId) || actorId === memberId) return false;
  if (makeAdmin) chat.admins.add(memberId);
  else chat.admins.delete(memberId);
  save();
  return true;
}

function updateGroup(chatId, actorId, patch = {}) {
  const chat = chats.get(chatId);
  if (!chat || chat.type !== 'group') return null;
  if ((patch.name !== undefined || patch.about !== undefined) && !canPerform(chat, actorId, 'editInfo')) return null;
  if (patch.name !== undefined) chat.name = String(patch.name).trim().slice(0, 100) || chat.name;
  if (patch.about !== undefined) chat.about = String(patch.about).trim().slice(0, 500);
  if (patch.permissions && canAdmin(chat, actorId)) {
    for (const key of ['editInfo', 'sendMessages', 'addMembers']) {
      if (['admins', 'members'].includes(patch.permissions[key])) chat.permissions[key] = patch.permissions[key];
    }
  }
  save();
  return chat;
}

function setDisappearing(chatId, actorId, seconds) {
  const chat = chats.get(chatId);
  const value = Number(seconds);
  if (!chat?.members.has(actorId) || ![0, 86400, 604800, 7776000].includes(value)) return null;
  if (chat.type === 'group' && !canAdmin(chat, actorId)) return null;
  chat.disappearingSeconds = value;
  save();
  return chat;
}

function setAdvancedPrivacy(chatId, actorId, enabled) {
  const chat = chats.get(chatId);
  if (!chat?.members.has(actorId)) return null;
  if (chat.type === 'group' && !canAdmin(chat, actorId)) return null;
  chat.advancedPrivacy = !!enabled;
  save();
  return chat;
}

function findOrCreateDM(a, b) {
  for (const chat of chats.values()) {
    if (chat.type === 'dm' && chat.members.size === 2 && chat.members.has(a) && chat.members.has(b)) return chat;
  }
  return createChat({ name: 'Direct message', type: 'dm', members: [a, b], createdBy: a });
}

function lastVisibleMessage(chatId, userId) {
  const list = messagesByChat.get(chatId) || [];
  const state = getState(userId, chatId);
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message.timestamp <= (state.clearedAt || 0)) break;
    if (message.deletedFor.has(userId) || (message.expiresAt && message.expiresAt <= Date.now())) continue;
    return message;
  }
  return null;
}

function unreadCount(chatId, userId) {
  const list = messagesByChat.get(chatId) || [];
  const state = getState(userId, chatId);
  let count = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message.timestamp <= state.lastReadAt) break;
    if (message.expiresAt && message.expiresAt <= Date.now()) continue;
    if (message.senderId === userId || message.deletedFor.has(userId)) continue;
    count += 1;
  }
  return Math.max(count, state.manualUnread ? 1 : 0);
}

function chatView(chat, userId) {
  const last = lastVisibleMessage(chat.id, userId);
  const state = getState(userId, chat.id);
  const members = [...chat.members];
  let name = chat.name;
  let peer = null;
  if (chat.type === 'dm') {
    const otherId = members.find(member => member !== userId) || userId;
    peer = publicUser(users.get(otherId), userId);
    name = peer?.username || 'Unknown';
  }
  return {
    id: chat.id,
    type: chat.type,
    name,
    about: chat.about || '',
    members,
    admins: [...(chat.admins || [])],
    permissions: chat.permissions || null,
    peer,
    createdAt: chat.createdAt,
    createdBy: chat.createdBy,
    disappearingSeconds: chat.disappearingSeconds || 0,
    advancedPrivacy: !!chat.advancedPrivacy,
    lastMessage: last ? outMessage(last, userId) : null,
    unread: unreadCount(chat.id, userId),
    pinned: !!state.pinned,
    favorite: !!state.favorite,
    muted: !!state.muted,
    archived: !!state.archived,
  };
}

function getUserChats(userId) {
  return [...chats.values()]
    .filter(chat => chat.members.has(userId))
    .map(chat => chatView(chat, userId))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.lastMessage?.timestamp || b.createdAt) - (a.lastMessage?.timestamp || a.createdAt);
    });
}

const CHAT_FLAGS = new Set(['archived', 'pinned', 'favorite', 'muted', 'manualUnread']);
function setChatFlag(userId, chatId, flag, value) {
  if (!CHAT_FLAGS.has(flag) || !chats.get(chatId)?.members.has(userId)) return null;
  const state = getState(userId, chatId);
  state[flag] = !!value;
  save();
  return state;
}

function clearChat(userId, chatId) {
  if (!chats.get(chatId)?.members.has(userId)) return false;
  const state = getState(userId, chatId);
  state.clearedAt = Date.now();
  save();
  return true;
}

function createInvite(chatId, actorId) {
  const chat = chats.get(chatId);
  if (!chat || !canPerform(chat, actorId, 'addMembers')) return null;
  for (const [code, invite] of inviteLinks) {
    if (invite.chatId === chatId && !invite.revokedAt) invite.revokedAt = Date.now();
  }
  const code = crypto.randomBytes(18).toString('base64url');
  inviteLinks.set(code, { chatId, createdBy: actorId, createdAt: Date.now(), revokedAt: null });
  save();
  return code;
}

function revokeInvites(chatId, actorId) {
  const chat = chats.get(chatId);
  if (!chat || !canAdmin(chat, actorId)) return false;
  let changed = false;
  for (const invite of inviteLinks.values()) {
    if (invite.chatId === chatId && !invite.revokedAt) {
      invite.revokedAt = Date.now();
      changed = true;
    }
  }
  if (changed) save();
  return changed;
}

function joinByInvite(userId, code) {
  const invite = inviteLinks.get(String(code || ''));
  const chat = invite && chats.get(invite.chatId);
  if (!invite || invite.revokedAt || !chat || chat.type !== 'group') return null;
  chat.members.add(userId);
  save();
  return chat;
}

// ── Messages ──────────────────────────────────────────────────────────

function statusOf(message, viewerId) {
  if (message.senderId !== viewerId) return null;
  const chat = chats.get(message.chatId);
  if (!chat) return 'sent';
  const others = [...chat.members].filter(id => id !== message.senderId);
  if (!others.length) return 'sent';
  if (others.every(id => message.readBy.has(id))) return 'read';
  if (others.some(id => message.deliveredTo.has(id))) return 'delivered';
  return 'sent';
}

function outMessage(message, viewerId) {
  const sender = users.get(message.senderId);
  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    clientId: message.clientId || null,
    sender: sender ? { id: sender.id, username: sender.username, avatar: sender.avatar, color: sender.color } : null,
    text: message.deleted ? '' : message.text,
    file: message.deleted ? null : message.file,
    call: message.call || null,
    type: message.type,
    timestamp: message.timestamp,
    editedAt: message.editedAt || null,
    deleted: !!message.deleted,
    replyTo: message.deleted ? null : (message.replyTo || null),
    reactions: message.deleted ? {} : (message.reactions || {}),
    readBy: [...message.readBy],
    deliveredTo: [...message.deliveredTo],
    status: statusOf(message, viewerId),
    starred: message.starredBy?.has(viewerId) || false,
    pinnedUntil: message.pinnedUntil || null,
    expiresAt: message.expiresAt || null,
    forwarded: !!message.forwarded,
    // Reserved encrypted-envelope metadata. Plaintext clients do not set it.
    encryption: message.encryption || null,
  };
}

function findByClientId(chatId, senderId, clientId) {
  if (!clientId) return null;
  const list = messagesByChat.get(chatId) || [];
  const cutoff = Date.now() - CLIENT_ID_WINDOW_MS;
  for (let index = list.length - 1; index >= 0 && index >= list.length - 300; index -= 1) {
    const message = list[index];
    if (message.timestamp < cutoff) break;
    if (message.senderId === senderId && message.clientId === clientId) return message;
  }
  return null;
}

function addMessage({ chatId, senderId, text, file, type, replyTo, call, clientId, encryption, forwarded }) {
  const chat = chats.get(chatId);
  const timestamp = Date.now();
  const message = {
    id: uuidv4(), chatId, senderId,
    clientId: clientId || null,
    text: text || '', file: file || null, call: call || null,
    type: type || (file ? 'file' : 'text'),
    timestamp,
    expiresAt: chat?.disappearingSeconds ? timestamp + chat.disappearingSeconds * 1000 : null,
    editedAt: null, deleted: false,
    replyTo: replyTo || null,
    reactions: {},
    readBy: new Set([senderId]),
    deliveredTo: new Set([senderId]),
    deletedFor: new Set(),
    starredBy: new Set(),
    pinnedUntil: null,
    forwarded: !!forwarded,
    encryption: encryption || null,
  };
  const list = messagesByChat.get(chatId) || [];
  list.push(message);
  messagesByChat.set(chatId, list);
  if (file?.id) claimAttachment(file.id, senderId, chatId, message.id);
  save();
  return message;
}

function getRawMessage(chatId, messageId) {
  return (messagesByChat.get(chatId) || []).find(message => message.id === messageId) || null;
}

function getMessages(chatId, userId, limit = 200) {
  const state = getState(userId, chatId);
  const now = Date.now();
  return (messagesByChat.get(chatId) || [])
    .filter(message => message.timestamp > (state.clearedAt || 0)
      && !message.deletedFor.has(userId)
      && (!message.expiresAt || message.expiresAt > now))
    .slice(-Math.min(Math.max(Number(limit) || 200, 1), 500))
    .map(message => outMessage(message, userId));
}

function markDelivered(chatId, userId) {
  const changed = [];
  for (const message of messagesByChat.get(chatId) || []) {
    if (message.senderId !== userId && !message.deliveredTo.has(userId)) {
      message.deliveredTo.add(userId);
      changed.push(message.id);
    }
  }
  if (changed.length) save();
  return changed;
}

function markRead(chatId, userId, shareReceipt = true) {
  const changed = [];
  for (const message of messagesByChat.get(chatId) || []) {
    if (message.senderId !== userId && !message.readBy.has(userId)) {
      message.deliveredTo.add(userId);
      if (shareReceipt) {
        message.readBy.add(userId);
        changed.push(message.id);
      }
    }
  }
  const state = getState(userId, chatId);
  state.lastReadAt = Date.now();
  state.manualUnread = false;
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
  const message = getRawMessage(chatId, messageId);
  if (!message || message.senderId !== userId || message.deleted || Date.now() - message.timestamp > 15 * 60 * 1000) return null;
  message.text = String(text || '').slice(0, 10000);
  message.editedAt = Date.now();
  save();
  return message;
}

function deleteMessage(chatId, messageId, userId, forEveryone) {
  const message = getRawMessage(chatId, messageId);
  if (!message) return null;
  if (forEveryone) {
    if (message.senderId !== userId && !canAdmin(chats.get(chatId), userId)) return null;
    message.deleted = true;
    message.text = '';
    message.file = null;
    message.reactions = {};
    message.replyTo = null;
  } else message.deletedFor.add(userId);
  save();
  return message;
}

function toggleReaction(chatId, messageId, userId, emoji) {
  const message = getRawMessage(chatId, messageId);
  if (!message || message.deleted) return null;
  message.reactions ||= {};
  const current = Object.keys(message.reactions).find(key => (message.reactions[key] || []).includes(userId));
  if (current) {
    message.reactions[current] = message.reactions[current].filter(id => id !== userId);
    if (!message.reactions[current].length) delete message.reactions[current];
  }
  if (current !== emoji) message.reactions[emoji] = [...(message.reactions[emoji] || []), userId];
  save();
  return message;
}

function toggleStar(chatId, messageId, userId) {
  const message = getRawMessage(chatId, messageId);
  if (!message) return null;
  message.starredBy ||= new Set();
  if (message.starredBy.has(userId)) message.starredBy.delete(userId);
  else message.starredBy.add(userId);
  save();
  return message;
}

function pinMessage(chatId, messageId, userId, durationSeconds = 86400) {
  const chat = chats.get(chatId);
  const message = getRawMessage(chatId, messageId);
  if (!chat?.members.has(userId) || !message || (chat.type === 'group' && !canAdmin(chat, userId))) return null;
  const seconds = [0, 86400, 604800, 2592000].includes(Number(durationSeconds)) ? Number(durationSeconds) : 86400;
  message.pinnedUntil = seconds ? Date.now() + seconds * 1000 : null;
  save();
  return message;
}

function forwardMessage(sourceChatId, messageId, userId, targetChatIds = []) {
  const sourceChat = chats.get(sourceChatId);
  const original = getRawMessage(sourceChatId, messageId);
  if (!sourceChat?.members.has(userId) || sourceChat.advancedPrivacy || !original || original.deleted) return [];
  const sent = [];
  for (const targetId of [...new Set(targetChatIds)].slice(0, 5)) {
    const target = chats.get(targetId);
    if (!target?.members.has(userId) || !canPerform(target, userId, 'sendMessages')) continue;
    if (target.type === 'dm') {
      const peer = [...target.members].find(id => id !== userId);
      if (peer && isBlockedBetween(userId, peer)) continue;
    }
    const file = original.file?.id
      ? cloneAttachmentForChat(original.file.id, userId, sourceChatId, targetId)
      : null;
    if (original.file && !file && !original.text) continue;
    sent.push(addMessage({
      chatId: targetId, senderId: userId,
      text: original.text, file,
      type: original.type, call: null,
      forwarded: true,
    }));
  }
  return sent;
}

function searchMessages(userId, query) {
  const needle = norm(query);
  if (!needle) return [];
  const results = [];
  for (const chat of chats.values()) {
    if (!chat.members.has(userId)) continue;
    for (const message of messagesByChat.get(chat.id) || []) {
      if (message.deleted || message.deletedFor.has(userId) || (message.expiresAt && message.expiresAt <= Date.now())) continue;
      if (norm(message.text).includes(needle)) results.push({ chat: chatView(chat, userId), message: outMessage(message, userId) });
    }
  }
  return results.sort((a, b) => b.message.timestamp - a.message.timestamp).slice(0, 50);
}

function pruneExpiredMessages() {
  const now = Date.now();
  const removed = [];
  for (const [chatId, list] of messagesByChat) {
    const keep = [];
    for (const message of list) {
      if (message.expiresAt && message.expiresAt <= now) removed.push({ chatId, messageId: message.id });
      else keep.push(message);
    }
    messagesByChat.set(chatId, keep);
  }
  if (removed.length) save();
  return removed;
}

// ── Protected attachment metadata ─────────────────────────────────────

function registerAttachment({ ownerId, chatId, storageName, name, mime, size }) {
  const chat = chats.get(chatId);
  if (!chat?.members.has(ownerId)) return null;
  const attachment = {
    id: uuidv4(), ownerId, chatId,
    storageName,
    name: String(name || 'attachment').slice(0, 255),
    mime: String(mime || 'application/octet-stream').slice(0, 120),
    size: Number(size) || 0,
    createdAt: Date.now(),
    messageId: null,
  };
  attachments.set(attachment.id, attachment);
  save();
  return attachment;
}

function claimAttachment(id, ownerId, chatId, messageId) {
  const attachment = attachments.get(id);
  if (!attachment || attachment.ownerId !== ownerId || attachment.chatId !== chatId) return null;
  attachment.messageId = messageId;
  save();
  return attachment;
}

function getAttachment(id, viewerId) {
  const attachment = attachments.get(id);
  if (!attachment || !chats.get(attachment.chatId)?.members.has(viewerId)) return null;
  // Before a file is posted, only its uploader may preview it. Once claimed by
  // a message, every current chat member may retrieve it through this route.
  if (!attachment.messageId && attachment.ownerId !== viewerId) return null;
  return attachment;
}

function attachmentFileView(attachment) {
  return {
    id: attachment.id,
    url: `/api/messenger/media/${encodeURIComponent(attachment.id)}`,
    name: attachment.name,
    mimeType: attachment.mime,
    size: attachment.size,
  };
}

function validateAttachment(id, ownerId, chatId) {
  const attachment = attachments.get(id);
  if (!attachment || attachment.ownerId !== ownerId || attachment.chatId !== chatId || attachment.messageId) return null;
  return attachmentFileView(attachment);
}

function cloneAttachmentForChat(id, ownerId, sourceChatId, targetChatId) {
  const source = attachments.get(id);
  const sourceChat = chats.get(sourceChatId);
  const targetChat = chats.get(targetChatId);
  if (!source?.messageId || source.chatId !== sourceChatId
      || !sourceChat?.members.has(ownerId) || !targetChat?.members.has(ownerId)) return null;
  const clone = {
    ...source,
    id: uuidv4(),
    ownerId,
    chatId: targetChatId,
    createdAt: Date.now(),
    messageId: null,
  };
  attachments.set(clone.id, clone);
  return attachmentFileView(clone);
}

// ── Call feedback ─────────────────────────────────────────────────────

const RATING_TAGS = [
  'Audio was choppy', 'Could not hear anything', 'Video was frozen', 'Video was blurry',
  'Audio and video out of sync', 'Call dropped', 'Echo or background noise', 'Took too long to connect',
];

function rateCall({ callId, userId, chatId, media, stars, tags, note, duration }) {
  const value = Math.round(Number(stars));
  if (!callId || !userId || !Number.isFinite(value) || value < 1 || value > 5) return null;
  const key = `${callId}:${userId}`;
  if (callRatings.has(key)) return callRatings.get(key);
  const cleanTags = [...new Set(Array.isArray(tags) ? tags : [])].filter(tag => RATING_TAGS.includes(tag));
  const rating = {
    callId, userId, chatId: chatId || null,
    media: media === 'video' ? 'video' : 'audio', stars: value,
    tags: cleanTags, note: String(note || '').trim().slice(0, 300),
    duration: Math.max(0, Math.round(Number(duration) || 0)), at: Date.now(),
  };
  callRatings.set(key, rating);
  save();
  return rating;
}

function hasRated(callId, userId) { return callRatings.has(`${callId}:${userId}`); }
function getCallRatings({ userId = null, since = null } = {}) {
  let list = [...callRatings.values()];
  if (userId) list = list.filter(rating => rating.userId === userId);
  if (since) list = list.filter(rating => rating.at >= since);
  return list.sort((a, b) => b.at - a.at);
}
function ratingSummary({ userId = null, since = null } = {}) {
  const list = getCallRatings({ userId, since });
  const spread = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const tally = {};
  let total = 0;
  for (const rating of list) {
    spread[rating.stars] += 1;
    total += rating.stars;
    for (const tag of rating.tags) tally[tag] = (tally[tag] || 0) + 1;
  }
  return {
    count: list.length,
    average: list.length ? Number((total / list.length).toFixed(2)) : null,
    spread,
    topIssues: Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })),
    notes: list.filter(rating => rating.note).slice(0, 50).map(rating => ({ stars: rating.stars, note: rating.note, at: rating.at })),
  };
}

module.exports = {
  SCHEMA_VERSION, DATA_DIR, DB_FILE, GENERAL_ROOM_ID, RATING_TAGS, AVATAR_COLORS, DEFAULT_PRIVACY,
  // users and auth
  upsertUser, upsertUserByPhone, getUser, getUserBySocket, attachSocket, detachSocket,
  updateProfile, setProfilePhoto, clearProfilePhoto, updatePrivacy, setTwoStepPin, clearTwoStepPin, verifyTwoStepPin,
  getAllUsers, getOnlineUsers, publicUser, accountView, findUserByName,
  normalizePhone, findUserByPhone, issueCode, verifyCode, isPhoneVerified, consumePhoneVerification,
  createSession, sessionForToken, userForSession, destroySession, listSessions, revokeSession, revokeOtherSessions,
  blockUser, isBlockedBetween, isKnownContact, reportUser,
  // chats and groups
  createChat, getChat, joinChat, leaveChat, removeMember, setAdmin, updateGroup, canAdmin, canPerform,
  setDisappearing, setAdvancedPrivacy, findOrCreateDM, getUserChats, chatView, setChatFlag, clearChat, unreadCount,
  createInvite, revokeInvites, joinByInvite,
  // messages
  addMessage, findByClientId, getMessages, getRawMessage, outMessage, markRead, markDelivered,
  markAllDelivered, editMessage, deleteMessage, toggleReaction, toggleStar, pinMessage,
  forwardMessage, searchMessages, pruneExpiredMessages,
  // media
  registerAttachment, getAttachment, validateAttachment,
  // calls
  rateCall, hasRated, getCallRatings, ratingSummary,
  save,
};
