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
const reels = new Map();
const stories = new Map();
const storyCampaigns = new Map();
const reports = [];
const inviteLinks = new Map();

const norm = value => String(value || '').trim().toLowerCase();
const tokenDigest = token => crypto.createHash('sha256').update(String(token || '')).digest('hex');
const stateKey = (userId, chatId) => `${userId}:${chatId}`;
const allowedAudience = new Set(['everyone', 'contacts', 'nobody']);
const BUSINESS_CATEGORIES = new Set([
  'retail', 'food', 'beauty', 'health', 'professional_services', 'education',
  'technology', 'media', 'travel', 'nonprofit', 'creator', 'other',
]);
const MAX_CHAT_LOCK_CREDENTIALS = 10;
const HANDLE_RE = /^[a-z][a-z0-9_]{2,19}$/;
const RESERVED_HANDLES = new Set(['admin', 'vchat', 'valmont', 'support', 'general', 'everyone', 'official']);

function cleanHttpsUrl(value) {
  if (!String(value || '').trim()) return '';
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.toString().slice(0, 1000) : '';
  } catch {
    return '';
  }
}

function normalizeBusinessProfile(value = {}, fallbackName = '') {
  const profile = value || {};
  const category = BUSINESS_CATEGORIES.has(profile.category) ? profile.category : 'other';
  const email = String(profile.email || '').trim().toLowerCase();
  return {
    name: [...String(profile.name || fallbackName || '').trim()].slice(0, 80).join(''),
    category,
    description: [...String(profile.description || '').trim()].slice(0, 500).join(''),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 200) : '',
    website: cleanHttpsUrl(profile.website),
    address: [...String(profile.address || '').trim()].slice(0, 240).join(''),
    hours: [...String(profile.hours || '').trim()].slice(0, 160).join(''),
  };
}

function normalizeChatLock(value = {}) {
  const lock = value || {};
  return {
    pinHash: typeof lock.pinHash === 'string' ? lock.pinHash : null,
    pinSalt: typeof lock.pinSalt === 'string' ? lock.pinSalt : null,
    credentials: Array.isArray(lock.credentials) ? lock.credentials
      .filter(item => item && typeof item.id === 'string' && typeof item.publicKey === 'string')
      .slice(0, MAX_CHAT_LOCK_CREDENTIALS)
      .map(item => ({
        id: item.id,
        publicKey: item.publicKey,
        counter: Math.max(0, Number(item.counter) || 0),
        transports: Array.isArray(item.transports) ? item.transports.slice(0, 8) : [],
        name: String(item.name || 'Passkey').slice(0, 80),
        createdAt: Number(item.createdAt) || Date.now(),
      })) : [],
  };
}

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
      // Locked is per-account rather than global to the conversation. A locked
      // chat is omitted from normal projections until this session proves the
      // account's chat-lock PIN or passkey.
      locked: false,
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
    openedBy: [...(message.openedBy || [])],
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
    reels: [...reels.values()].map(reel => ({ ...reel, likedBy: [...reel.likedBy] })),
    stories: [...stories.values()].map(story => ({
      ...story,
      viewedBy: [...story.viewedBy],
      reactions: [...story.reactions.entries()],
    })),
    storyCampaigns: [...storyCampaigns.values()].map(campaign => ({
      ...campaign,
      impressionUsers: [...campaign.impressionUsers],
      clickUsers: [...campaign.clickUsers],
    })),
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
        accountType: saved.accountType === 'business' ? 'business' : 'personal',
        businessProfile: saved.accountType === 'business' ? normalizeBusinessProfile(saved.businessProfile, saved.username) : null,
        chatLock: normalizeChatLock(saved.chatLock),
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
        openedBy: new Set(message.openedBy || (message.senderId ? [message.senderId] : [])),
        viewOnce: !!message.viewOnce,
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
    for (const saved of raw.reels || []) {
      if (!saved?.id || !users.has(saved.ownerId)) continue;
      reels.set(saved.id, { ...saved, likedBy: new Set(saved.likedBy || []) });
    }
    for (const saved of raw.stories || []) {
      // Keep expired records until the media maintenance pass can remove both
      // metadata and protected bytes; dropping them here would orphan files.
      if (!saved?.id || !users.has(saved.ownerId)) continue;
      stories.set(saved.id, {
        ...saved,
        viewedBy: new Set((saved.viewedBy || []).filter(id => users.has(id))),
        reactions: new Map((saved.reactions || []).filter(([id]) => users.has(id))),
      });
    }
    for (const saved of raw.storyCampaigns || []) {
      if (!saved?.id || !users.has(saved.advertiserId)) continue;
      storyCampaigns.set(saved.id, {
        ...saved,
        impressionUsers: new Set((saved.impressionUsers || []).filter(id => users.has(id))),
        clickUsers: new Set((saved.clickUsers || []).filter(id => users.has(id))),
      });
    }
    for (const value of raw.reports || []) reports.push(value);
    for (const [key, value] of raw.inviteLinks || []) inviteLinks.set(key, value);
    for (const user of users.values()) {
      if (!user.handle) user.handle = suggestHandle(user.username || user.phone || user.id, user.id);
    }
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
    handle: user.handle || null,
    username: user.username,
    avatar: audienceAllows(user, viewerId, privacy.profilePhoto) ? (user.avatar || null) : null,
    photoUrl: audienceAllows(user, viewerId, privacy.profilePhoto) && user.profilePhoto
      ? `/api/messenger/profile-photo/${encodeURIComponent(user.id)}?v=${Number(user.profilePhoto.updatedAt) || 0}`
      : null,
    color: user.color,
    about: audienceAllows(user, viewerId, privacy.about) ? (user.about || 'Hey there! I am using VChat.') : '',
    status: showOnline ? user.status : 'private',
    lastSeen: showLastSeen ? user.lastSeen : null,
    accountType: user.accountType === 'business' ? 'business' : 'personal',
    business: user.accountType === 'business'
      ? normalizeBusinessProfile(user.businessProfile, user.username) : null,
    blocked: isSelf ? [...(user.blocked || [])] : undefined,
  };
}

function accountView(user, sessionToken = null) {
  if (!user) return null;
  const lock = normalizeChatLock(user.chatLock);
  return {
    ...publicUser(user, user.id),
    phone: user.phone || null,
    privacy: defaultPrivacy(user.privacy),
    createdAt: user.createdAt,
    twoStepEnabled: !!user.pinHash,
    chatLockEnabled: !!lock.pinHash,
    chatLockPasskeyCount: lock.credentials.length,
    chatLockUnlockedUntil: sessionToken && isChatLockSessionUnlocked(sessionToken)
      ? sessionForToken(sessionToken)?.chatLockUnlockedUntil : null,
    lockedChatCount: countLockedChats(user.id),
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

/** Unique public username: @daniel, 3–20 chars, letter first. */
function normalizeHandle(raw) {
  const s = String(raw || '').trim().replace(/^@+/, '').toLowerCase();
  if (!HANDLE_RE.test(s) || RESERVED_HANDLES.has(s)) return null;
  return s;
}

function findUserByHandle(handle) {
  const h = String(handle || '').trim().replace(/^@+/, '').toLowerCase();
  if (!h) return null;
  for (const user of users.values()) if (user.handle === h) return user;
  return null;
}

function suggestHandle(username, exceptId) {
  const base = String(username || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 16) || 'user';
  const seed = HANDLE_RE.test(base) ? base : (`user${base}`.replace(/[^a-z0-9_]/g, '').slice(0, 16) || 'user');
  if (!findUserByHandle(seed) || findUserByHandle(seed)?.id === exceptId) return seed;
  for (let i = 2; i < 1000; i += 1) {
    const next = `${seed.slice(0, 16)}${i}`.slice(0, 20);
    if (!findUserByHandle(next) || findUserByHandle(next)?.id === exceptId) return next;
  }
  return `user${crypto.randomBytes(3).toString('hex')}`;
}

function searchUsers(query, exceptId) {
  const raw = String(query || '').trim().replace(/^@+/, '');
  if (raw.length < 2) return [];
  const q = raw.toLowerCase();
  const out = [];
  for (const user of users.values()) {
    if (exceptId && user.id === exceptId) continue;
    const handle = user.handle || '';
    const name = norm(user.username);
    if (handle.startsWith(q) || handle.includes(q) || name.includes(q)) {
      out.push(publicUser(user, exceptId || null));
    }
    if (out.length >= 20) break;
  }
  out.sort((a, b) => {
    const ah = (a.handle || '').startsWith(q) ? 0 : 1;
    const bh = (b.handle || '').startsWith(q) ? 0 : 1;
    return ah - bh || (a.handle || '').localeCompare(b.handle || '');
  });
  return out;
}

function makeUser({ phone = null, username, handle, avatar = null, about = null, accountType = 'personal', businessProfile = null }) {
  const id = uuidv4();
  const cleanType = accountType === 'business' ? 'business' : 'personal';
  const cleanName = String(username || phone || 'VChat user').trim();
  const wanted = normalizeHandle(handle) || suggestHandle(cleanName || phone, id);
  if (findUserByHandle(wanted)) {
    return { error: 'That username is already taken' };
  }
  const user = {
    id, phone,
    handle: wanted,
    username: cleanName,
    avatar,
    color: AVATAR_COLORS[users.size % AVATAR_COLORS.length],
    about: about || (cleanType === 'business' ? 'Business on VChat' : 'Hey there! I am using VChat.'),
    accountType: cleanType,
    businessProfile: cleanType === 'business' ? normalizeBusinessProfile(businessProfile, cleanName) : null,
    chatLock: normalizeChatLock(),
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

function upsertUserByPhone(phone, { username, handle, avatar, about, accountType, businessProfile } = {}) {
  let user = findUserByPhone(phone);
  if (!user) {
    user = makeUser({ phone, username, handle, avatar, about, accountType, businessProfile });
    if (user.error) return user;
  } else {
    if (username) user.username = String(username).trim();
    if (handle) {
      const next = normalizeHandle(handle);
      if (!next) {
        return { error: 'Username must be 3–20 characters, start with a letter, and use only letters, numbers or _' };
      }
      const clash = findUserByHandle(next);
      if (clash && clash.id !== user.id) return { error: 'That username is already taken' };
      user.handle = next;
    }
    if (!user.handle) user.handle = suggestHandle(user.username || phone, user.id);
    if (avatar !== undefined) user.avatar = avatar;
    if (about !== undefined) user.about = about;
    // Account type is immutable after registration. This prevents a modified
    // sign-in request from silently converting an existing personal account.
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

function setSessionPasskeyChallenge(token, challenge) {
  const session = sessionForToken(token);
  if (!session || !challenge?.value || !challenge?.purpose) return false;
  session.passkeyChallenge = {
    purpose: String(challenge.purpose),
    value: String(challenge.value),
    rpID: String(challenge.rpID || ''),
    origin: String(challenge.origin || ''),
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
  save();
  return true;
}

function getSessionPasskeyChallenge(token, purpose) {
  const session = sessionForToken(token);
  const challenge = session?.passkeyChallenge;
  if (!challenge || challenge.purpose !== purpose || challenge.expiresAt <= Date.now()) return null;
  return { ...challenge };
}

function clearSessionPasskeyChallenge(token) {
  const session = sessionForToken(token);
  if (!session) return false;
  delete session.passkeyChallenge;
  save();
  return true;
}

function unlockChatLockSession(token, durationMs = 15 * 60 * 1000) {
  const session = sessionForToken(token);
  if (!session) return null;
  const bounded = Math.max(60 * 1000, Math.min(60 * 60 * 1000, Number(durationMs) || 15 * 60 * 1000));
  session.chatLockUnlockedUntil = Date.now() + bounded;
  delete session.passkeyChallenge;
  save();
  return session.chatLockUnlockedUntil;
}

function lockChatLockSession(token) {
  const session = sessionForToken(token);
  if (!session) return false;
  session.chatLockUnlockedUntil = null;
  delete session.passkeyChallenge;
  save();
  return true;
}

function isChatLockSessionUnlocked(token) {
  const session = sessionForToken(token);
  return Boolean(session?.chatLockUnlockedUntil && session.chatLockUnlockedUntil > Date.now());
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

function updateProfile(userId, { username, handle, avatar, about }) {
  const user = users.get(userId);
  if (!user) return null;
  if (username && norm(username) !== norm(user.username)) {
    user.username = String(username).trim().slice(0, 40);
  }
  if (handle !== undefined) {
    const next = normalizeHandle(handle);
    if (!next) {
      return { error: 'Username must be 3–20 characters, start with a letter, and use only letters, numbers or _' };
    }
    const clash = findUserByHandle(next);
    if (clash && clash.id !== userId) return { error: 'That username is already taken' };
    user.handle = next;
  }
  if (!user.handle) user.handle = suggestHandle(user.username || user.phone || user.id, user.id);
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

function verifyChatLockPin(user, pin) {
  const lock = normalizeChatLock(user?.chatLock);
  const clean = String(pin || '').replace(/\D/g, '');
  if (!lock.pinHash || !lock.pinSalt || clean.length !== 6) return false;
  const candidate = crypto.scryptSync(clean, Buffer.from(lock.pinSalt, 'base64'), 32);
  return crypto.timingSafeEqual(Buffer.from(lock.pinHash, 'base64'), candidate);
}

function setChatLockPin(userId, pin, currentPin = null) {
  const user = users.get(userId);
  const clean = String(pin || '').replace(/\D/g, '');
  if (!user || clean.length !== 6) return { error: 'Choose a 6-digit chat-lock PIN' };
  const existing = normalizeChatLock(user.chatLock);
  if (existing.pinHash && !verifyChatLockPin(user, currentPin)) return { error: 'Current chat-lock PIN is incorrect' };
  const salt = crypto.randomBytes(16);
  user.chatLock = {
    ...existing,
    pinSalt: salt.toString('base64'),
    pinHash: crypto.scryptSync(clean, salt, 32).toString('base64'),
  };
  save();
  return { ok: true };
}

function addChatLockCredential(userId, credential) {
  const user = users.get(userId);
  if (!user || !credential?.id || !credential?.publicKey) return null;
  const lock = normalizeChatLock(user.chatLock);
  const next = {
    id: String(credential.id),
    publicKey: String(credential.publicKey),
    counter: Math.max(0, Number(credential.counter) || 0),
    transports: Array.isArray(credential.transports) ? credential.transports.slice(0, 8) : [],
    name: String(credential.name || 'Device passkey').slice(0, 80),
    createdAt: Date.now(),
  };
  const replacing = lock.credentials.some(item => item.id === next.id);
  if (!replacing && lock.credentials.length >= MAX_CHAT_LOCK_CREDENTIALS) {
    return { error: `You can register up to ${MAX_CHAT_LOCK_CREDENTIALS} chat-lock passkeys` };
  }
  lock.credentials = lock.credentials.filter(item => item.id !== next.id);
  lock.credentials.push(next);
  user.chatLock = lock;
  save();
  return { ...next };
}

function getChatLockCredential(userId, credentialId) {
  const user = users.get(userId);
  return normalizeChatLock(user?.chatLock).credentials.find(item => item.id === credentialId) || null;
}

function updateChatLockCredentialCounter(userId, credentialId, counter) {
  const user = users.get(userId);
  const credential = user && normalizeChatLock(user.chatLock).credentials.find(item => item.id === credentialId);
  if (!credential) return false;
  credential.counter = Math.max(0, Number(counter) || 0);
  // normalizeChatLock returns a copy, so update the persisted record too.
  const stored = user.chatLock?.credentials?.find(item => item.id === credentialId);
  if (stored) stored.counter = credential.counter;
  save();
  return true;
}

function listChatLockCredentials(userId) {
  return normalizeChatLock(users.get(userId)?.chatLock).credentials.map(item => ({
    id: item.id, name: item.name, transports: item.transports, createdAt: item.createdAt,
  }));
}

function removeChatLockCredential(userId, credentialId, pin) {
  const user = users.get(userId);
  if (!user || !verifyChatLockPin(user, pin)) return false;
  const lock = normalizeChatLock(user.chatLock);
  const before = lock.credentials.length;
  lock.credentials = lock.credentials.filter(item => item.id !== credentialId);
  if (lock.credentials.length === before) return false;
  user.chatLock = lock;
  save();
  return true;
}

function updateBusinessProfile(userId, patch = {}) {
  const user = users.get(userId);
  if (!user || user.accountType !== 'business') return null;
  user.businessProfile = normalizeBusinessProfile({ ...user.businessProfile, ...patch }, user.username);
  save();
  return businessProfileView(userId, userId);
}

function businessProfileView(ownerId, viewerId) {
  const owner = users.get(ownerId);
  if (!owner || owner.accountType !== 'business' || !users.has(viewerId)
      || isBlockedBetween(ownerId, viewerId)) return null;
  return {
    owner: publicUser(owner, viewerId),
    profile: normalizeBusinessProfile(owner.businessProfile, owner.username),
    canEdit: ownerId === viewerId,
  };
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
    locked: !!state.locked,
  };
}

function isChatLocked(userId, chatId) {
  return Boolean(chats.get(chatId)?.members.has(userId) && getState(userId, chatId).locked);
}

function countLockedChats(userId) {
  let count = 0;
  for (const chat of chats.values()) if (chat.members.has(userId) && getState(userId, chat.id).locked) count += 1;
  return count;
}

function setChatLocked(userId, chatId, locked) {
  const user = users.get(userId);
  if (!user || !chats.get(chatId)?.members.has(userId) || !normalizeChatLock(user.chatLock).pinHash) return null;
  const state = getState(userId, chatId);
  state.locked = !!locked;
  save();
  return state;
}

function getUserChats(userId, revealLocked = false) {
  return [...chats.values()]
    .filter(chat => chat.members.has(userId) && (revealLocked || !getState(userId, chat.id).locked))
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
  const viewOnce = !!message.viewOnce;
  const openedByViewer = viewOnce && message.senderId !== viewerId && message.openedBy?.has(viewerId);
  const visibleFile = message.deleted || openedByViewer ? null : (message.file ? {
    ...message.file,
    // A recipient must explicitly consume View Once media. The normal URL is
    // never exposed before that one-time server transition.
    url: viewOnce && message.senderId !== viewerId ? null : message.file.url,
  } : null);
  return {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    clientId: message.clientId || null,
    sender: sender ? { id: sender.id, username: sender.username, avatar: sender.avatar, color: sender.color } : null,
    text: message.deleted ? '' : message.text,
    file: visibleFile,
    viewOnce,
    viewOnceOpened: openedByViewer,
    viewOnceOpenedCount: message.senderId === viewerId && viewOnce
      ? Math.max(0, (message.openedBy?.size || 1) - 1) : undefined,
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

function addMessage({ chatId, senderId, text, file, type, replyTo, call, clientId, encryption, forwarded, viewOnce = false }) {
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
    viewOnce: !!viewOnce && !!file && /^(image|video)\//i.test(file.mimeType || ''),
    openedBy: new Set([senderId]),
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

function markAllDelivered(userId, includeLocked = false) {
  const touched = [];
  for (const chat of chats.values()) {
    if (!chat.members.has(userId) || (!includeLocked && isChatLocked(userId, chat.id))) continue;
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
  if (!sourceChat?.members.has(userId) || sourceChat.advancedPrivacy || !original || original.deleted || original.viewOnce) return [];
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

function searchMessages(userId, query, revealLocked = false) {
  const needle = norm(query);
  if (!needle) return [];
  const results = [];
  for (const chat of chats.values()) {
    if (!chat.members.has(userId) || (!revealLocked && isChatLocked(userId, chat.id))) continue;
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

function getAttachment(id, viewerId, { allowViewOnce = false } = {}) {
  const attachment = attachments.get(id);
  if (!attachment || !chats.get(attachment.chatId)?.members.has(viewerId)) return null;
  // Before a file is posted, only its uploader may preview it. Once claimed by
  // a message, every current chat member may retrieve it through this route,
  // except View Once recipients who must use the consuming endpoint.
  if (!attachment.messageId && attachment.ownerId !== viewerId) return null;
  const message = attachment.messageId && getRawMessage(attachment.chatId, attachment.messageId);
  if (message?.viewOnce && attachment.ownerId !== viewerId && !allowViewOnce) return null;
  return attachment;
}

function openViewOnceMessage(chatId, messageId, viewerId) {
  const chat = chats.get(chatId);
  const message = getRawMessage(chatId, messageId);
  if (!chat?.members.has(viewerId) || !message?.viewOnce || message.deleted
      || message.senderId === viewerId || message.openedBy?.has(viewerId)
      || (message.expiresAt && message.expiresAt <= Date.now())) return null;
  const attachment = message.file?.id && attachments.get(message.file.id);
  if (!attachment || attachment.messageId !== message.id || attachment.chatId !== chatId) return null;
  message.openedBy ||= new Set([message.senderId]);
  message.openedBy.add(viewerId);
  save();
  return { attachment, message };
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

// ── Reels ──────────────────────────────────────────────────────────────

function reelAllowed(reel, viewerId) {
  return Boolean(reel && users.has(viewerId) && users.has(reel.ownerId)
    && !isBlockedBetween(reel.ownerId, viewerId));
}

function reelView(reel, viewerId) {
  if (!reelAllowed(reel, viewerId)) return null;
  const owner = publicUser(users.get(reel.ownerId), viewerId);
  return {
    id: reel.id,
    owner,
    caption: reel.caption,
    mimeType: reel.mime,
    size: reel.size,
    createdAt: reel.createdAt,
    videoUrl: `/api/reels/${encodeURIComponent(reel.id)}/media`,
    liked: reel.likedBy.has(viewerId),
    likeCount: reel.likedBy.size,
  };
}

function createReel(ownerId, { storageName, mime, size, caption }) {
  if (!users.has(ownerId) || !storageName || !/^video\/(mp4|quicktime|webm)$/i.test(String(mime))) return null;
  const reel = {
    id: uuidv4(),
    ownerId,
    storageName: path.basename(String(storageName)),
    mime: String(mime).toLowerCase(),
    size: Math.max(0, Number(size) || 0),
    caption: [...String(caption || '').trim()].slice(0, 220).join(''),
    createdAt: Date.now(),
    likedBy: new Set(),
  };
  reels.set(reel.id, reel);
  save();
  return reelView(reel, ownerId);
}

function getReel(id, viewerId) {
  const reel = reels.get(id);
  return reelAllowed(reel, viewerId) ? reel : null;
}

function reelCursor(reel) {
  return Buffer.from(JSON.stringify([reel.createdAt, reel.id])).toString('base64url');
}

function parseReelCursor(cursor) {
  if (!cursor) return null;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!Number.isFinite(createdAt) || typeof id !== 'string') return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function listReels(viewerId, { cursor = null, limit = 10 } = {}) {
  const pageSize = Math.max(1, Math.min(30, Math.floor(Number(limit) || 10)));
  const after = parseReelCursor(cursor);
  if (cursor && !after) return null;
  let list = [...reels.values()]
    .filter(reel => reelAllowed(reel, viewerId))
    .sort((a, b) => (b.createdAt - a.createdAt) || b.id.localeCompare(a.id));
  if (after) {
    list = list.filter(reel => reel.createdAt < after.createdAt
      || (reel.createdAt === after.createdAt && reel.id.localeCompare(after.id) < 0));
  }
  const page = list.slice(0, pageSize);
  return {
    items: page.map(reel => reelView(reel, viewerId)),
    nextCursor: list.length > pageSize && page.length ? reelCursor(page[page.length - 1]) : null,
  };
}

function setReelLike(id, userId, liked) {
  const reel = getReel(id, userId);
  if (!reel) return null;
  if (liked) reel.likedBy.add(userId);
  else reel.likedBy.delete(userId);
  save();
  return reelView(reel, userId);
}

function deleteReel(id, ownerId) {
  const reel = reels.get(id);
  if (!reel || reel.ownerId !== ownerId) return null;
  reels.delete(id);
  save();
  return reel;
}

// ── Status stories and sponsored story campaigns ─────────────────────

const STORY_TTL_MS = 24 * 60 * 60 * 1000;
const STORY_REACTIONS = ['❤️', '😂', '😮', '😢', '👏', '🔥'];
const STORY_BACKGROUNDS = ['jade', 'ocean', 'sunset', 'violet', 'charcoal'];
const CAMPAIGN_OBJECTIVES = ['profile_visits', 'website_visits', 'messages'];
const CAMPAIGN_CTAS = ['Learn more', 'Visit profile', 'Send message', 'Sign up'];

function areStoryContacts(ownerId, viewerId) {
  return ownerId !== viewerId
    && isKnownContact(ownerId, viewerId)
    && isKnownContact(viewerId, ownerId);
}

function storyAllowed(story, viewerId, now = Date.now()) {
  if (!story || !users.has(viewerId) || !users.has(story.ownerId) || story.expiresAt <= now) return false;
  if (story.ownerId === viewerId) return true;
  return !isBlockedBetween(story.ownerId, viewerId) && areStoryContacts(story.ownerId, viewerId);
}

function storyView(story, viewerId) {
  if (!storyAllowed(story, viewerId)) return null;
  const mine = story.ownerId === viewerId;
  return {
    id: story.id,
    owner: publicUser(users.get(story.ownerId), viewerId),
    type: story.type,
    text: story.text,
    background: story.background,
    mimeType: story.mime || null,
    size: story.size || 0,
    mediaUrl: story.storageName ? `/api/stories/${encodeURIComponent(story.id)}/media` : null,
    createdAt: story.createdAt,
    expiresAt: story.expiresAt,
    mine,
    seen: mine || story.viewedBy.has(viewerId),
    viewCount: mine ? story.viewedBy.size : undefined,
    reactionCount: mine ? story.reactions.size : undefined,
    myReaction: story.reactions.get(viewerId) || null,
    allowSave: mine ? !!story.allowSave : undefined,
    canSave: mine || !!story.allowSave,
    saveUrl: (mine || story.allowSave) ? `/api/stories/${encodeURIComponent(story.id)}/save` : null,
  };
}

function createStory(ownerId, { type, text, background, storageName, mime, size, allowSave = false } = {}) {
  if (!users.has(ownerId) || !['text', 'image', 'video'].includes(type)) return null;
  const cleanText = [...String(text || '').trim()].slice(0, 700).join('');
  if (type === 'text' && !cleanText) return null;
  if (type !== 'text' && !storageName) return null;
  const now = Date.now();
  const story = {
    id: uuidv4(),
    ownerId,
    type,
    text: cleanText,
    background: STORY_BACKGROUNDS.includes(background) ? background : 'jade',
    storageName: storageName ? path.basename(String(storageName)) : null,
    mime: mime ? String(mime).toLowerCase() : null,
    size: Math.max(0, Number(size) || 0),
    audience: 'contacts',
    allowSave: allowSave === true,
    createdAt: now,
    expiresAt: now + STORY_TTL_MS,
    viewedBy: new Set(),
    reactions: new Map(),
  };
  stories.set(story.id, story);
  save();
  return storyView(story, ownerId);
}

function getStory(id, viewerId) {
  const story = stories.get(id);
  return storyAllowed(story, viewerId) ? story : null;
}

function listStories(viewerId) {
  if (!users.has(viewerId)) return [];
  const grouped = new Map();
  const visible = [...stories.values()]
    .filter(story => storyAllowed(story, viewerId))
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const story of visible) {
    if (!grouped.has(story.ownerId)) grouped.set(story.ownerId, []);
    grouped.get(story.ownerId).push(storyView(story, viewerId));
  }
  return [...grouped.entries()]
    .map(([ownerId, items]) => ({
      owner: publicUser(users.get(ownerId), viewerId),
      mine: ownerId === viewerId,
      unseenCount: ownerId === viewerId ? 0 : items.filter(item => !item.seen).length,
      latestAt: items[items.length - 1]?.createdAt || 0,
      items,
    }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || b.latestAt - a.latestAt);
}

function recordStoryView(id, viewerId) {
  const story = getStory(id, viewerId);
  if (!story) return null;
  if (story.ownerId !== viewerId && !story.viewedBy.has(viewerId)) {
    story.viewedBy.add(viewerId);
    save();
  }
  return storyView(story, viewerId);
}

function setStoryReaction(id, viewerId, reaction) {
  const story = getStory(id, viewerId);
  if (!story || story.ownerId === viewerId) return null;
  if (reaction == null || reaction === '') story.reactions.delete(viewerId);
  else if (STORY_REACTIONS.includes(reaction)) story.reactions.set(viewerId, reaction);
  else return null;
  save();
  return storyView(story, viewerId);
}

function deleteStory(id, ownerId) {
  const story = stories.get(id);
  if (!story || story.ownerId !== ownerId) return null;
  stories.delete(id);
  save();
  return story;
}

function pruneExpiredStories(now = Date.now()) {
  const removed = [];
  for (const story of stories.values()) {
    if (story.expiresAt > now) continue;
    stories.delete(story.id);
    removed.push(story);
  }
  if (removed.length) save();
  return removed;
}

function safeCampaignUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString().slice(0, 1000) : null;
  } catch {
    return null;
  }
}

function campaignStatus(campaign, now = Date.now()) {
  if (['active', 'paused'].includes(campaign.deliveryStatus) && campaign.endAt && campaign.endAt <= now) return 'completed';
  if (campaign.deliveryStatus === 'active') return 'active';
  if (campaign.reviewStatus === 'rejected') return 'rejected';
  if (['paused', 'stopped', 'expired'].includes(campaign.deliveryStatus)) return campaign.deliveryStatus;
  if (campaign.paymentStatus === 'failed') return 'payment_failed';
  if (campaign.reviewStatus === 'pending') return 'pending_review';
  if (!['paid', 'waived'].includes(campaign.paymentStatus)) return 'pending_payment';
  return campaign.deliveryStatus || 'pending';
}

function maybeActivateCampaign(campaign, now = Date.now()) {
  if (campaign.reviewStatus !== 'approved' || !['paid', 'waived'].includes(campaign.paymentStatus)) return false;
  // `stopped`, `rejected`, `expired`, and `completed` are terminal. A late
  // payment webhook must never restart a campaign the advertiser already ended.
  if (campaign.deliveryStatus !== 'pending') return false;
  campaign.deliveryStatus = 'active';
  campaign.startAt = now;
  campaign.endAt = now + campaign.durationDays * 24 * 60 * 60 * 1000;
  return true;
}

function campaignView(campaign, viewerId, { admin = false } = {}) {
  if (!campaign || !users.has(campaign.advertiserId)) return null;
  const ownerView = campaign.advertiserId === viewerId || admin;
  return {
    id: campaign.id,
    advertiser: publicUser(users.get(campaign.advertiserId), viewerId),
    sourceStoryId: ownerView ? campaign.sourceStoryId : undefined,
    type: campaign.type,
    text: campaign.text,
    background: campaign.background,
    mimeType: campaign.mime || null,
    mediaUrl: campaign.storageName ? `/api/story-ads/${encodeURIComponent(campaign.id)}/media` : null,
    objective: campaign.objective,
    cta: campaign.cta,
    destinationUrl: campaign.destinationUrl,
    audience: campaign.audience,
    budgetGhs: ownerView ? campaign.budgetGhs : undefined,
    durationDays: ownerView ? campaign.durationDays : undefined,
    billingEmail: ownerView ? campaign.billingEmail : undefined,
    status: campaignStatus(campaign),
    reviewStatus: ownerView ? campaign.reviewStatus : undefined,
    paymentStatus: ownerView ? campaign.paymentStatus : undefined,
    paymentProvider: ownerView ? campaign.paymentProvider : undefined,
    paymentReference: ownerView ? campaign.paymentReference : undefined,
    checkoutUrl: ownerView ? campaign.checkoutUrl || null : undefined,
    reviewNote: ownerView ? campaign.reviewNote : undefined,
    reviewedAt: ownerView ? campaign.reviewedAt || null : undefined,
    reviewer: ownerView && campaign.reviewedBy ? publicUser(users.get(campaign.reviewedBy), viewerId) : undefined,
    stopNote: ownerView ? campaign.stopNote || null : undefined,
    stoppedAt: ownerView ? campaign.stoppedAt || null : undefined,
    stopActor: ownerView && campaign.stoppedBy ? publicUser(users.get(campaign.stoppedBy), viewerId) : undefined,
    createdAt: campaign.createdAt,
    startAt: campaign.startAt,
    endAt: campaign.endAt,
    impressionCount: ownerView ? campaign.impressionCount : undefined,
    reachCount: ownerView ? campaign.impressionUsers.size : undefined,
    clickCount: ownerView ? campaign.clickCount : undefined,
    durationSeconds: 30,
    sponsored: true,
  };
}

function createStoryCampaign(advertiserId, sourceStoryId, {
  storageName, type, mime, size, text, background, objective, cta, destinationUrl,
  audience, budgetGhs, durationDays, billingEmail, paymentProvider,
} = {}) {
  const story = stories.get(sourceStoryId);
  const budget = Number(budgetGhs);
  const days = Math.round(Number(durationDays));
  const email = [...String(billingEmail || '').trim().toLowerCase()].slice(0, 254).join('');
  if (!story || story.ownerId !== advertiserId || !Number.isFinite(budget) || budget < 10 || budget > 10000
      || !Number.isFinite(days) || days < 1 || days > 14 || !/^\S+@\S+\.\S+$/.test(email)) return null;
  const cleanObjective = CAMPAIGN_OBJECTIVES.includes(objective) ? objective : 'profile_visits';
  const cleanCta = CAMPAIGN_CTAS.includes(cta) ? cta : 'Learn more';
  const url = safeCampaignUrl(destinationUrl);
  if (cleanObjective === 'website_visits' && !url) return null;
  const campaign = {
    id: uuidv4(),
    advertiserId,
    sourceStoryId,
    type: ['text', 'image', 'video'].includes(type) ? type : story.type,
    storageName: storageName ? path.basename(String(storageName)) : null,
    mime: mime || story.mime || null,
    size: Math.max(0, Number(size) || 0),
    text: [...String(text ?? story.text ?? '').trim()].slice(0, 700).join(''),
    background: STORY_BACKGROUNDS.includes(background) ? background : story.background,
    objective: cleanObjective,
    cta: cleanCta,
    destinationUrl: url,
    audience: audience === 'contacts' ? 'contacts' : 'broad',
    budgetGhs: Number(budget.toFixed(2)),
    durationDays: days,
    billingEmail: email,
    paymentProvider: paymentProvider || null,
    paymentStatus: paymentProvider ? 'initializing' : 'configuration_required',
    paymentReference: null,
    checkoutUrl: null,
    expectedAmountMinor: Math.round(budget * 100),
    reviewStatus: 'pending',
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    deliveryStatus: 'pending',
    stoppedBy: null,
    stoppedAt: null,
    stopNote: null,
    createdAt: Date.now(),
    startAt: null,
    endAt: null,
    impressionCount: 0,
    clickCount: 0,
    impressionUsers: new Set(),
    clickUsers: new Set(),
  };
  storyCampaigns.set(campaign.id, campaign);
  save();
  return campaignView(campaign, advertiserId);
}

function setCampaignPaymentInitialization(id, advertiserId, { provider, reference, authorizationUrl, initialized, error } = {}) {
  const campaign = storyCampaigns.get(id);
  if (!campaign || campaign.advertiserId !== advertiserId) return null;
  campaign.paymentProvider = provider || campaign.paymentProvider;
  campaign.paymentReference = reference || campaign.paymentReference;
  campaign.checkoutUrl = safeCampaignUrl(authorizationUrl) || campaign.checkoutUrl;
  campaign.paymentStatus = initialized ? 'pending' : (error === 'configuration_required' ? 'configuration_required' : 'failed');
  save();
  return campaignView(campaign, advertiserId);
}

function findCampaignByPaymentReference(reference) {
  return [...storyCampaigns.values()].find(campaign => campaign.paymentReference === reference) || null;
}

function confirmCampaignPayment(reference, { amount, currency, providerId } = {}) {
  const campaign = findCampaignByPaymentReference(reference);
  if (!campaign || String(currency).toUpperCase() !== 'GHS'
      || Number(amount) !== campaign.expectedAmountMinor) return null;
  campaign.paymentStatus = 'paid';
  campaign.paymentProviderId = providerId ? String(providerId) : campaign.paymentProviderId;
  campaign.paidAt = campaign.paidAt || Date.now();
  maybeActivateCampaign(campaign);
  save();
  return campaign;
}

function reviewStoryCampaign(id, { approved, note, waivePayment = false, reviewerId } = {}) {
  const campaign = storyCampaigns.get(id);
  const cleanNote = [...String(note || '').trim()].slice(0, 300).join('');
  if (!campaign || !users.has(reviewerId) || (!approved && !cleanNote)
      || (waivePayment && (!approved || !cleanNote))
      || campaign.reviewStatus !== 'pending' || campaign.deliveryStatus !== 'pending') return null;
  campaign.reviewStatus = approved ? 'approved' : 'rejected';
  campaign.reviewNote = cleanNote || null;
  campaign.reviewedBy = reviewerId;
  campaign.reviewedAt = Date.now();
  if (approved && waivePayment && campaign.paymentStatus !== 'paid') {
    campaign.paymentStatus = 'waived';
    campaign.paymentWaivedBy = reviewerId;
  }
  if (!approved) {
    campaign.deliveryStatus = 'stopped';
    campaign.stoppedBy = reviewerId;
    campaign.stoppedAt = campaign.reviewedAt;
    campaign.stopNote = campaign.reviewNote;
  }
  else maybeActivateCampaign(campaign);
  save();
  return campaign;
}

function controlStoryCampaign(id, actorId, action, { admin = false, note = '', now = Date.now() } = {}) {
  const campaign = storyCampaigns.get(id);
  const owner = campaign?.advertiserId === actorId;
  const cleanNote = [...String(note || '').trim()].slice(0, 300).join('');
  if (!campaign || !users.has(actorId) || (!owner && !(admin && action === 'stop'))
      || (!owner && admin && action === 'stop' && !cleanNote)) return null;
  const status = campaignStatus(campaign, now);
  if (owner && action === 'pause' && status === 'active') {
    campaign.deliveryStatus = 'paused';
    campaign.pausedAt = now;
  } else if (owner && action === 'resume' && status === 'paused') {
    if (!campaign.endAt || campaign.endAt <= now) campaign.deliveryStatus = 'completed';
    else campaign.deliveryStatus = 'active';
  } else if (action === 'stop' && !['completed', 'expired', 'rejected', 'stopped'].includes(status)) {
    campaign.deliveryStatus = 'stopped';
    campaign.stoppedBy = actorId;
    campaign.stoppedAt = now;
    campaign.stopNote = cleanNote || null;
  } else {
    return null;
  }
  save();
  return campaignView(campaign, actorId, { admin });
}

function listStoryCampaigns(advertiserId) {
  return [...storyCampaigns.values()]
    .filter(campaign => campaign.advertiserId === advertiserId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(campaign => campaignView(campaign, advertiserId));
}

function listStoryCampaignsForReview(viewerId) {
  return [...storyCampaigns.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(campaign => campaignView(campaign, viewerId, { admin: true }));
}

function campaignEligible(campaign, viewerId, now = Date.now()) {
  if (!campaign || !users.has(viewerId) || campaign.advertiserId === viewerId
      || campaignStatus(campaign, now) !== 'active' || isBlockedBetween(campaign.advertiserId, viewerId)) return false;
  if (campaign.audience === 'contacts' && !areStoryContacts(campaign.advertiserId, viewerId)) return false;
  return true;
}

function listEligibleStoryAds(viewerId) {
  return [...storyCampaigns.values()]
    .filter(campaign => campaignEligible(campaign, viewerId))
    .sort((a, b) => a.impressionUsers.has(viewerId) - b.impressionUsers.has(viewerId)
      || a.impressionCount - b.impressionCount || a.createdAt - b.createdAt)
    .slice(0, 3)
    .map(campaign => campaignView(campaign, viewerId));
}

function getStoryCampaignMedia(id, viewerId, admin = false) {
  const campaign = storyCampaigns.get(id);
  if (!campaign?.storageName) return null;
  if (admin || campaign.advertiserId === viewerId || campaignEligible(campaign, viewerId)) return campaign;
  return null;
}

function recordCampaignEvent(id, viewerId, event) {
  const campaign = storyCampaigns.get(id);
  if (!campaignEligible(campaign, viewerId)) return null;
  if (event === 'impression') {
    if (!campaign.impressionUsers.has(viewerId)) campaign.impressionCount += 1;
    campaign.impressionUsers.add(viewerId);
  } else if (event === 'click') {
    if (!campaign.clickUsers.has(viewerId)) campaign.clickCount += 1;
    campaign.clickUsers.add(viewerId);
  } else return null;
  save();
  return campaignView(campaign, viewerId);
}

function pruneExpiredStoryCampaigns(now = Date.now()) {
  const media = [];
  let changed = false;
  for (const campaign of storyCampaigns.values()) {
    const stalePending = !['active', 'paused'].includes(campaign.deliveryStatus)
      && now - campaign.createdAt > 30 * 24 * 60 * 60 * 1000;
    const ended = ['active', 'paused'].includes(campaign.deliveryStatus) && campaign.endAt <= now;
    if (!stalePending && !ended) continue;
    campaign.deliveryStatus = ended ? 'completed' : 'expired';
    if (campaign.storageName) {
      media.push(campaign.storageName);
      campaign.storageName = null;
    }
    changed = true;
  }
  if (changed) save();
  return media;
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
  STORY_TTL_MS, STORY_REACTIONS, STORY_BACKGROUNDS, CAMPAIGN_OBJECTIVES, CAMPAIGN_CTAS, BUSINESS_CATEGORIES,
  MAX_CHAT_LOCK_CREDENTIALS,
  // users and auth
  upsertUser, upsertUserByPhone, getUser, getUserBySocket, attachSocket, detachSocket,
  normalizeHandle, findUserByHandle, suggestHandle, searchUsers, HANDLE_RE,
  updateProfile, setProfilePhoto, clearProfilePhoto, updatePrivacy, setTwoStepPin, clearTwoStepPin, verifyTwoStepPin,
  setChatLockPin, verifyChatLockPin, addChatLockCredential, getChatLockCredential,
  updateChatLockCredentialCounter, listChatLockCredentials, removeChatLockCredential,
  updateBusinessProfile, businessProfileView,
  getAllUsers, getOnlineUsers, publicUser, accountView, findUserByName,
  normalizePhone, findUserByPhone, issueCode, verifyCode, isPhoneVerified, consumePhoneVerification,
  createSession, sessionForToken, userForSession, destroySession, listSessions, revokeSession, revokeOtherSessions,
  setSessionPasskeyChallenge, getSessionPasskeyChallenge, clearSessionPasskeyChallenge,
  unlockChatLockSession, lockChatLockSession, isChatLockSessionUnlocked,
  blockUser, isBlockedBetween, isKnownContact, reportUser,
  // chats and groups
  createChat, getChat, joinChat, leaveChat, removeMember, setAdmin, updateGroup, canAdmin, canPerform,
  setDisappearing, setAdvancedPrivacy, findOrCreateDM, getUserChats, chatView, setChatFlag, clearChat, unreadCount,
  isChatLocked, countLockedChats, setChatLocked,
  createInvite, revokeInvites, joinByInvite,
  // messages
  addMessage, findByClientId, getMessages, getRawMessage, outMessage, markRead, markDelivered,
  markAllDelivered, editMessage, deleteMessage, toggleReaction, toggleStar, pinMessage,
  forwardMessage, searchMessages, pruneExpiredMessages,
  // media and reels
  registerAttachment, getAttachment, validateAttachment, openViewOnceMessage,
  createReel, getReel, reelView, listReels, setReelLike, deleteReel,
  // stories and story advertising
  createStory, getStory, listStories, recordStoryView, setStoryReaction, deleteStory, pruneExpiredStories,
  createStoryCampaign, setCampaignPaymentInitialization, findCampaignByPaymentReference,
  confirmCampaignPayment, reviewStoryCampaign, controlStoryCampaign, listStoryCampaigns, listStoryCampaignsForReview,
  listEligibleStoryAds, getStoryCampaignMedia, recordCampaignEvent, pruneExpiredStoryCampaigns,
  // calls
  rateCall, hasRated, getCallRatings, ratingSummary,
  save,
};
