/* ============================================================
   VChat client — WhatsApp-style behaviour
   ============================================================ */
(() => {
'use strict';

// ── State ──────────────────────────────────────────────────────────────
let socket = null;
let me = null;
let chats = [];
let users = [];
let activeId = null;
let messages = [];
let replyTo = null;
let pendingFile = null;
let filter = 'all';
let searchQuery = '';
let typingUsers = new Map();   // chatId -> Map(userId -> {name, timer})
const typingTimers = {};
let unseen = 0;

const AVATARS = ['😀','😎','🦊','🐼','🐯','🦁','🐸','🐵','🦄','🐙','🌟','🚀','🔥','🍀','🎧','⚽','🎸','🌺','🍕','🐨'];
const EMOJI_GROUPS = {
  'Smileys': ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤗','🤭','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','😮','😯','😴','🥱','😌','😔','😪','🤤','😷','🤒','🤕','🤧','🥳','🥸','😎','🤓','🧐','😕','😟','🙁','😮‍💨','😢','😭','😤','😠','😡','🤬','😱','😨','😰','😥'],
  'Gestures': ['👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋','🤝','🙏','💪','🦾','👏','🙌','👐','🤲','✍️','💅'],
  'Hearts': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💯','💥','💫','⭐','🌟','✨','🔥','🎉','🎊','🎁'],
  'Objects': ['📱','💻','⌨️','🖥️','🖨️','📷','🎥','📺','⏰','⏱️','📅','📌','📎','📁','📊','📈','💰','💳','🔑','🔒','📚','✏️','🖊️','📝','☕','🍵','🍕','🍔','🍟','🌮','🍎','🍌','⚽','🏀','🎮','🎧','🎸','🚗','✈️','🏠'],
};

// ── Tiny DOM helpers ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const icon = (name, cls = 'icon') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2400);
}

// ── Formatting ─────────────────────────────────────────────────────────
function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  const startOf = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function rowTime(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return timeOf(ts);
  const diff = Math.round((now - d) / 86400000);
  if (diff <= 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function lastSeenText(u) {
  if (!u) return '';
  if (u.status === 'online') return 'online';
  if (!u.lastSeen) return 'offline';
  const d = new Date(u.lastSeen);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `last seen today at ${timeOf(u.lastSeen)}` : `last seen ${dayLabel(u.lastSeen).toLowerCase()} at ${timeOf(u.lastSeen)}`;
}
function fileSize(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}
function colorFor(id) {
  const palette = ['#00a884','#53bdeb','#7f66ff','#f2a33c','#e542a3','#25d366','#ff6b6b','#0088cc','#b06bff','#f15c6d'];
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}
const isEmojiOnly = t => t && /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f\s]+$/u.test(t) && [...t.replace(/\s/g, '')].length <= 6;

function linkify(text) {
  return esc(text).replace(/(https?:\/\/[^\s<]+)/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}

/** Replace the node with `id` by a freshly rendered avatar, keeping id + extra classes. */
function setAvatar(id, entity, size, showPresence, extraClass = '') {
  const node = $(id);
  if (!node) return null;
  const tmp = el('div', '', avatarHTML(entity, size, showPresence));
  const fresh = tmp.firstElementChild;
  fresh.id = id;
  if (extraClass) fresh.classList.add(...extraClass.split(' '));
  node.replaceWith(fresh);
  return fresh;
}

function avatarHTML(entity, size = 40, showPresence = false) {
  const isUser = entity && 'username' in entity;
  const name = isUser ? entity.username : (entity?.name || '?');
  const emoji = entity?.avatar;
  const bg = entity?.color || colorFor(entity?.id || name);
  const inner = emoji ? esc(emoji) : (entity?.type === 'group' ? icon('group', 'icon') : esc(initials(name)));
  const dot = showPresence ? `<span class="presence ${entity?.status === 'online' ? 'on' : ''}"></span>` : '';
  return `<div class="avatar sz-${size}" style="background:${emoji ? 'var(--panel-alt)' : bg}">${inner}${dot}</div>`;
}

function tickHTML(status) {
  if (!status) return '';
  if (status === 'read') return `<span class="tick read">${icon('checks', 'icon-sm')}</span>`;
  if (status === 'delivered') return `<span class="tick">${icon('checks', 'icon-sm')}</span>`;
  if (status === 'pending') return `<span class="tick">${icon('clock', 'icon-sm')}</span>`;
  return `<span class="tick">${icon('check', 'icon-sm')}</span>`;
}

function previewOf(m) {
  if (!m) return '';
  if (m.deleted) return '🚫 This message was deleted';
  if (m.type === 'system') return m.text;
  if (m.file) {
    const t = m.file.mimeType || '';
    if (m.file.voice) return `🎤 Voice note (${clockOf(m.file.duration || 0)})`;
    if (t.startsWith('image/')) return '📷 Photo';
    if (t.startsWith('video/')) return '🎥 Video';
    if (t.startsWith('audio/')) return '🎵 Audio';
    return '📄 ' + m.file.name;
  }
  return m.text;
}

// ── Login ──────────────────────────────────────────────────────────────
let pickedAvatar = AVATARS[0];

function buildAvatarPicker(container, selected, onPick) {
  container.innerHTML = '';
  AVATARS.forEach(a => {
    const b = el('button', 'avatar-opt' + (a === selected ? ' sel' : ''), a);
    b.onclick = () => {
      container.querySelectorAll('.avatar-opt').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
      onPick(a);
    };
    container.appendChild(b);
  });
}

// Dial codes — the user's country is guessed from the browser locale/timezone.
const DIAL_CODES = [
  ['GH', '233', 'Ghana'], ['NG', '234', 'Nigeria'], ['KE', '254', 'Kenya'],
  ['ZA', '27', 'South Africa'], ['US', '1', 'United States'], ['GB', '44', 'United Kingdom'],
  ['CA', '1', 'Canada'], ['IN', '91', 'India'], ['DE', '49', 'Germany'],
  ['FR', '33', 'France'], ['ES', '34', 'Spain'], ['IT', '39', 'Italy'],
  ['NL', '31', 'Netherlands'], ['BR', '55', 'Brazil'], ['MX', '52', 'Mexico'],
  ['AU', '61', 'Australia'], ['CN', '86', 'China'], ['JP', '81', 'Japan'],
  ['AE', '971', 'United Arab Emirates'], ['EG', '20', 'Egypt'], ['ET', '251', 'Ethiopia'],
  ['TZ', '255', 'Tanzania'], ['UG', '256', 'Uganda'], ['CI', '225', "Côte d'Ivoire"],
  ['SN', '221', 'Senegal'], ['CM', '237', 'Cameroon'], ['MA', '212', 'Morocco'],
  ['PK', '92', 'Pakistan'], ['BD', '880', 'Bangladesh'], ['PH', '63', 'Philippines'],
];

const flagOf = cc => cc.replace(/./g, c => String.fromCodePoint(127397 + c.charCodeAt(0)));

let authPhone = null;      // E.164 string from the server
let resendTimer = null;

// Timezone → country, for the dial codes we list. Timezone reflects where the
// user physically is, which beats the browser's language region (an en-US
// browser in Accra should still default to +233).
const TZ_COUNTRY = {
  'Africa/Accra': 'GH', 'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE',
  'Africa/Johannesburg': 'ZA', 'Africa/Cairo': 'EG', 'Africa/Addis_Ababa': 'ET',
  'Africa/Dar_es_Salaam': 'TZ', 'Africa/Kampala': 'UG', 'Africa/Abidjan': 'CI',
  'Africa/Dakar': 'SN', 'Africa/Douala': 'CM', 'Africa/Casablanca': 'MA',
  'Europe/London': 'GB', 'Europe/Berlin': 'DE', 'Europe/Paris': 'FR',
  'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL',
  'America/Sao_Paulo': 'BR', 'America/Mexico_City': 'MX', 'America/Toronto': 'CA',
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Dubai': 'AE',
  'Asia/Karachi': 'PK', 'Asia/Dhaka': 'BD', 'Asia/Manila': 'PH',
  'Asia/Shanghai': 'CN', 'Asia/Tokyo': 'JP', 'Australia/Sydney': 'AU',
};

function guessCountry() {
  const known = cc => cc && DIAL_CODES.some(d => d[0] === cc);
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (known(TZ_COUNTRY[tz])) return TZ_COUNTRY[tz];
    if (/^America\//.test(tz)) return 'US';
  } catch { /* no Intl */ }
  try {
    const region = new Intl.Locale(navigator.language).region;
    if (known(region)) return region;
  } catch { /* older browsers */ }
  return 'GH';
}

function showStep(id) {
  ['step-phone', 'step-code', 'step-profile'].forEach(s => { $(s).hidden = s !== id; });
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, data };
}

function initLogin() {
  if (localStorage.getItem('vchat.theme') === 'dark') document.body.classList.add('dark');

  // Country picker
  const sel = $('dial-select');
  const home = guessCountry();
  DIAL_CODES.forEach(([cc, dial, name]) => {
    const o = document.createElement('option');
    o.value = dial;
    o.textContent = `${flagOf(cc)} ${name} +${dial}`;
    o.dataset.cc = cc;
    if (cc === home) o.selected = true;
    sel.appendChild(o);
  });

  buildAvatarPicker($('avatar-picker'), pickedAvatar, a => { pickedAvatar = a; });
  const savedAvatar = localStorage.getItem('vchat.avatar');
  if (savedAvatar) { pickedAvatar = savedAvatar; buildAvatarPicker($('avatar-picker'), pickedAvatar, a => { pickedAvatar = a; }); }
  const savedName = localStorage.getItem('vchat.name');
  if (savedName) $('name-input').value = savedName;

  const savedPhone = localStorage.getItem('vchat.phone');
  if (savedPhone) {
    const match = DIAL_CODES.filter(d => savedPhone.startsWith('+' + d[1]))
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (match) { sel.value = match[1]; $('phone-input').value = savedPhone.slice(match[1].length + 1); }
  }

  $('btn-send-code').onclick = () => requestCode(false);
  $('phone-input').addEventListener('keydown', e => { if (e.key === 'Enter') requestCode(false); });
  $('phone-input').addEventListener('input', () => { $('login-err').textContent = ''; });

  $('code-back').onclick = () => { clearInterval(resendTimer); showStep('step-phone'); $('phone-input').focus(); };
  $('btn-verify').onclick = submitCode;
  $('btn-resend').onclick = () => requestCode(true);
  initCodeBoxes();

  $('login-btn').onclick = submitProfile;
  $('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitProfile(); });

  $('phone-input').focus();
  restoreSession();
}

/** Silently resume an existing session so you are not asked to verify twice. */
async function restoreSession() {
  const token = localStorage.getItem('vchat.token');
  if (!token) return;
  const { ok, data } = await api('/api/auth/session', { token });
  if (ok && data.user) connect(token);
  else localStorage.removeItem('vchat.token');
}

// ── Step 1: request a code ─────────────────────────────────────────────
async function requestCode(resend) {
  const isResend = resend === true;
  const dialCode = $('dial-select').value;
  const number = $('phone-input').value.trim();
  const errBox = isResend ? $('code-err') : $('login-err');
  errBox.textContent = '';

  if (number.replace(/\D/g, '').length < 6) {
    errBox.textContent = 'Enter a valid phone number';
    return;
  }

  const btn = isResend ? $('btn-resend') : $('btn-send-code');
  btn.disabled = true;
  const { ok, data } = await api('/api/auth/request-code', { dialCode, number });
  btn.disabled = false;

  if (!ok) { errBox.textContent = data.error || 'Could not send the code'; return; }

  authPhone = data.phone;
  $('code-target').textContent = data.phone;
  localStorage.setItem('vchat.phone', data.phone);
  if (data.username) $('name-input').value = data.username;

  // Dev mode: no SMS provider configured, so surface the code in the UI.
  const dev = $('dev-code');
  if (data.devCode) {
    dev.hidden = false;
    dev.innerHTML = `SMS is not configured on this server, so here is your code:<br><b>${esc(data.devCode)}</b>`;
  } else {
    dev.hidden = true;
  }

  showStep('step-code');
  startResendCountdown();
  const boxes = [...$('code-boxes').children];
  boxes.forEach(b => { b.value = ''; b.classList.remove('filled'); });
  boxes[0].focus();
  if (isResend) toast('New code sent');
}

function startResendCountdown() {
  clearInterval(resendTimer);
  let left = 30;
  const btn = $('btn-resend');
  btn.disabled = true;
  btn.textContent = `Resend code in ${left}s`;
  resendTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(resendTimer);
      btn.disabled = false;
      btn.textContent = 'Resend code';
    } else {
      btn.textContent = `Resend code in ${left}s`;
    }
  }, 1000);
}

// ── Step 2: enter the 6 digits ─────────────────────────────────────────
function codeValue() {
  return [...$('code-boxes').children].map(b => b.value).join('');
}

function initCodeBoxes() {
  const boxes = [...$('code-boxes').children];
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(0, 1);
      box.classList.toggle('filled', !!box.value);
      $('code-err').textContent = '';
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      if (codeValue().length === 6) submitCode();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
      if (e.key === 'Enter') submitCode();
    });
    box.addEventListener('paste', e => {
      e.preventDefault();
      const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      if (!digits) return;
      digits.split('').forEach((d, k) => {
        if (boxes[k]) { boxes[k].value = d; boxes[k].classList.add('filled'); }
      });
      boxes[Math.min(digits.length, 5)].focus();
      if (digits.length === 6) submitCode();
    });
  });
}

let verifying = false;
async function submitCode() {
  const code = codeValue();
  if (code.length !== 6 || verifying) return;
  verifying = true;
  $('btn-verify').disabled = true;
  $('code-err').textContent = '';

  const { ok, data } = await api('/api/auth/verify', {
    phone: authPhone,
    code,
    username: $('name-input').value.trim() || undefined,
    avatar: pickedAvatar,
  });
  verifying = false;
  $('btn-verify').disabled = false;

  if (!ok) {
    $('code-err').textContent = data.error || 'Verification failed';
    const boxes = [...$('code-boxes').children];
    boxes.forEach(b => { b.value = ''; b.classList.remove('filled'); });
    boxes[0].focus();
    return;
  }

  clearInterval(resendTimer);

  if (data.needsProfile) {          // new number → ask for a name
    showStep('step-profile');
    $('name-input').focus();
    return;
  }

  finishAuth(data);
}

// ── Step 3: name + avatar for first-time numbers ───────────────────────
async function submitProfile() {
  const username = $('name-input').value.trim();
  if (username.length < 2) { $('profile-err').textContent = 'Please enter at least 2 characters'; return; }
  $('profile-err').textContent = '';
  $('login-btn').disabled = true;

  // The code was consumed by the previous call, so ask for a fresh one and
  // verify in a single step is not possible — instead the server accepts the
  // profile with the still-valid pending registration.
  const { ok, data } = await api('/api/auth/register', {
    phone: authPhone, username, avatar: pickedAvatar,
  });
  $('login-btn').disabled = false;

  if (!ok) { $('profile-err').textContent = data.error || 'Could not create your profile'; return; }
  finishAuth(data);
}

function finishAuth({ token, user }) {
  localStorage.setItem('vchat.token', token);
  localStorage.setItem('vchat.name', user.username);
  localStorage.setItem('vchat.avatar', user.avatar || '');
  connect(token);
}

// ── Socket ─────────────────────────────────────────────────────────────
function connect(token) {
  if (socket) socket.close();
  socket = io({ transports: ['websocket', 'polling'], auth: { token } });

  socket.on('connect', () => {
    socket.emit('user:join', { token }, (res) => {
      $('login-btn').disabled = false;
      if (!res || res.error) {
        if (res?.signedOut) {           // token no longer valid → back to step 1
          localStorage.removeItem('vchat.token');
          socket.close();
          showStep('step-phone');
          $('login-err').textContent = 'Your session expired. Please sign in again.';
          return;
        }
        $('code-err').textContent = res?.error || 'Could not join';
        return;
      }
      me = res.user;
      chats = res.chats;
      users = res.users;
      localStorage.setItem('vchat.name', me.username);
      localStorage.setItem('vchat.avatar', me.avatar || '');
      $('login').style.display = 'none';
      document.body.classList.add('ready');
      renderMe();
      renderChatList();
      if (!activeId && window.innerWidth > 900) {
        const first = chats[0];
        if (first) openChat(first.id);
      }
    });
  });

  socket.on('disconnect', () => setPeerStatus('connecting…'));

  socket.on('chats:list', list => {
    chats = list;
    if (activeId && chats.some(c => c.id === activeId)) updateHeaderForActive();
    else renderChatList();
  });
  socket.on('chats:refresh', () => {});
  socket.on('users:list', list => {
    users = list;
    if (activeId) updateHeaderForActive(); else renderChatList();
    refreshDrawerIfOpen();
  });
  socket.on('presence:update', () => {});

  socket.on('chat:new', chat => {
    const i = chats.findIndex(c => c.id === chat.id);
    if (i >= 0) chats[i] = chat; else chats.unshift(chat);
    renderChatList();
  });

  socket.on('chat:removed', ({ chatId }) => {
    chats = chats.filter(c => c.id !== chatId);
    if (activeId === chatId) closeChat();
    renderChatList();
  });

  socket.on('chat:cleared', ({ chatId }) => {
    if (activeId === chatId) { messages = []; renderMessages(); }
  });

  socket.on('message:new', m => {
    if (m.chatId === activeId) {
      const stick = nearBottom();
      messages.push(m);
      renderMessages();
      if (stick || m.senderId === me.id) scrollBottom();
      else bumpJump();
      socket.emit('messages:read', { chatId: activeId });
    } else if (m.senderId !== me.id) {
      const c = chats.find(x => x.id === m.chatId);
      if (!c?.muted) ping();
    }
    if (m.senderId !== me.id && document.hidden) notifyTitle();
  });

  socket.on('message:updated', m => {
    const i = messages.findIndex(x => x.id === m.id);
    if (i >= 0) { messages[i] = m; renderMessages(); }
  });

  socket.on('message:removed', ({ chatId, messageId }) => {
    if (chatId !== activeId) return;
    messages = messages.filter(m => m.id !== messageId);
    renderMessages();
  });

  socket.on('messages:read', ({ chatId, messageIds }) => {
    if (chatId !== activeId) return;
    let touched = false;
    for (const m of messages) {
      if (messageIds.includes(m.id) && m.senderId === me.id) { m.status = 'read'; touched = true; }
    }
    if (touched) renderMessages();
  });

  socket.on('messages:delivered', ({ chatId, messageIds }) => {
    if (chatId !== activeId) return;
    let touched = false;
    for (const m of messages) {
      if (messageIds.includes(m.id) && m.senderId === me.id && m.status === 'sent') { m.status = 'delivered'; touched = true; }
    }
    if (touched) renderMessages();
  });

  socket.on('typing:start', ({ chatId, userId, username }) => {
    if (!typingUsers.has(chatId)) typingUsers.set(chatId, new Map());
    const map = typingUsers.get(chatId);
    clearTimeout(map.get(userId)?.timer);
    map.set(userId, { name: username, timer: setTimeout(() => { map.delete(userId); updateHeaderForActive(); }, 4000) });
    updateHeaderForActive();
  });

  socket.on('typing:stop', ({ chatId, userId }) => {
    const map = typingUsers.get(chatId);
    if (map) { clearTimeout(map.get(userId)?.timer); map.delete(userId); }
    updateHeaderForActive();
  });
}

// ── Notification helpers ───────────────────────────────────────────────
let audioCtx = null;
function ping() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 880; o.type = 'sine';
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.06, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.start(); o.stop(audioCtx.currentTime + 0.26);
  } catch (_) {}
}
function notifyTitle() {
  unseen++;
  document.title = `(${unseen}) VChat`;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { unseen = 0; document.title = 'VChat'; }
});

// ── Me / profile ───────────────────────────────────────────────────────
function renderMe() {
  const node = setAvatar('me-avatar', me, 40, false, 'me-avatar');
  if (node) { node.title = 'Profile'; node.onclick = openProfile; }
}

function openProfile() {
  const pv = setAvatar('profile-avatar', me, 140);
  if (pv) pv.style.margin = '8px auto 20px';
  let picked = me.avatar;
  buildAvatarPicker($('profile-avatar-picker'), me.avatar, a => {
    picked = a;
    const node = $('profile-avatar');
    node.textContent = a;
    node.style.background = 'var(--panel-alt)';
  });
  $('profile-name').value = me.username;
  $('profile-about').value = me.about || '';
  const phoneRow = $('profile-phone');
  if (phoneRow) phoneRow.textContent = me.phone || 'Not linked';
  $('profile-save').onclick = () => {
    socket.emit('profile:update', {
      username: $('profile-name').value.trim(),
      avatar: picked,
      about: $('profile-about').value.trim(),
    }, res => {
      if (res?.error) return toast(res.error);
      if (!res?.user) return toast('Could not update profile');
      me = res.user;
      localStorage.setItem('vchat.name', me.username);
      localStorage.setItem('vchat.avatar', me.avatar || '');
      renderMe();
      closeModal('modal-profile');
      toast('Profile updated');
    });
  };
  openModal('modal-profile');
}

// ── Chat list ──────────────────────────────────────────────────────────
function visibleChats() {
  let list = chats.slice();
  if (filter === 'unread') list = list.filter(c => c.unread > 0);
  else if (filter === 'groups') list = list.filter(c => c.type === 'group');
  else if (filter === 'archived') list = list.filter(c => c.archived);
  else list = list.filter(c => !c.archived);

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter(c => c.name.toLowerCase().includes(q) || (c.lastMessage?.text || '').toLowerCase().includes(q));
  }
  return list;
}

function renderChatList() {
  const box = $('chat-list');
  box.innerHTML = '';

  const list = visibleChats();

  // "Start a chat with" suggestions when searching
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    const matches = users.filter(u => u.id !== me.id && u.username.toLowerCase().includes(q) &&
      !chats.some(c => c.type === 'dm' && c.peer?.id === u.id));
    if (matches.length) {
      box.appendChild(el('div', 'list-section-title', 'Contacts'));
      matches.forEach(u => box.appendChild(contactRow(u)));
      if (list.length) box.appendChild(el('div', 'list-section-title', 'Chats'));
    }
  }

  if (!list.length && !box.children.length) {
    box.appendChild(el('div', 'empty-list',
      searchQuery ? 'No chats found.<br>Try a different search.'
                  : 'No conversations yet.<br>Tap the new-chat icon to start one.'));
    return;
  }

  list.forEach(c => box.appendChild(chatRow(c)));
}

function contactRow(u) {
  const row = el('div', 'chat-row');
  row.innerHTML = `
    ${avatarHTML(u, 49, true)}
    <div class="body">
      <div class="row-top"><div class="row-name">${esc(u.username)}</div></div>
      <div class="row-bottom"><div class="row-preview">${esc(u.about || 'Hey there! I am using VChat.')}</div></div>
    </div>`;
  row.onclick = () => {
    socket.emit('chat:startDM', { targetUserId: u.id }, res => {
      if (res?.chat) { $('search-input').value = ''; searchQuery = ''; openChat(res.chat.id); }
    });
  };
  return row;
}

function chatRow(c) {
  const row = el('div', 'chat-row' + (c.id === activeId ? ' sel' : '') + (c.unread ? ' unread' : ''));
  const last = c.lastMessage;
  const isGroup = c.type === 'group';
  const entity = c.type === 'dm'
    ? (users.find(u => u.id === c.peer?.id) || c.peer || { username: c.name, id: c.id })
    : { name: c.name, type: 'group', id: c.id };

  let prefix = '';
  if (last && last.type !== 'system') {
    if (last.senderId === me.id) prefix = tickHTML(last.status || 'sent');
    else if (isGroup) prefix = `<span>${esc(last.sender?.username || '')}:</span>`;
  }

  const typing = typingUsers.get(c.id);
  const typingActive = typing && typing.size > 0;
  const previewText = typingActive
    ? `<span style="color:var(--wa-green)">${esc([...typing.values()][0].name)} is typing…</span>`
    : (last ? esc(previewOf(last)) : '<span style="color:var(--text-muted)">No messages yet</span>');

  row.innerHTML = `
    ${avatarHTML(entity, 49, c.type === 'dm')}
    <div class="body">
      <div class="row-top">
        <div class="row-name">${esc(c.name)}</div>
        <div class="row-time">${last ? rowTime(last.timestamp) : ''}</div>
      </div>
      <div class="row-bottom">
        <div class="row-preview">${typingActive ? '' : prefix} ${previewText}</div>
        <div class="row-badges">
          ${c.pinned ? `<span class="row-icon">${icon('pin', 'icon-sm')}</span>` : ''}
          ${c.muted ? `<span class="row-icon">${icon('mute', 'icon-sm')}</span>` : ''}
          ${c.unread ? `<span class="unread-badge">${c.unread}</span>` : ''}
          <span class="row-menu">${icon('chevron', 'icon-sm')}</span>
        </div>
      </div>
    </div>`;

  row.onclick = () => openChat(c.id);
  row.querySelector('.row-menu').onclick = e => { e.stopPropagation(); chatContextMenu(e, c); };
  row.oncontextmenu = e => { e.preventDefault(); chatContextMenu(e, c); };
  return row;
}

function chatContextMenu(e, c) {
  const items = [
    { label: c.archived ? 'Unarchive chat' : 'Archive chat', fn: () => socket.emit('chat:flag', { chatId: c.id, flag: 'archived', value: !c.archived }) },
    { label: c.muted ? 'Unmute notifications' : 'Mute notifications', fn: () => socket.emit('chat:flag', { chatId: c.id, flag: 'muted', value: !c.muted }) },
    { label: c.pinned ? 'Unpin chat' : 'Pin chat', fn: () => socket.emit('chat:flag', { chatId: c.id, flag: 'pinned', value: !c.pinned }) },
    { sep: true },
    { label: 'Clear messages', fn: () => { if (confirm(`Clear all messages in "${c.name}"?`)) socket.emit('chat:clear', { chatId: c.id }); } },
  ];
  if (c.id !== 'general') {
    items.push({ label: c.type === 'group' ? 'Exit group' : 'Delete chat', danger: true, fn: () => {
      if (confirm(c.type === 'group' ? `Exit "${c.name}"?` : `Delete chat with ${c.name}?`)) socket.emit('chat:leave', { chatId: c.id });
    }});
  }
  showCtxMenu(e, items);
}

// ── Context menu ───────────────────────────────────────────────────────
let ctxOpenEvent = null;
function showCtxMenu(e, items, emojis) {
  const menu = $('ctx-menu');
  menu.innerHTML = '';
  if (emojis) {
    const bar = el('div', 'ctx-emoji');
    emojis.forEach(({ emoji, fn }) => { const b = el('button', '', emoji); b.onclick = () => { hideCtx(); fn(); }; bar.appendChild(b); });
    menu.appendChild(bar);
  }
  items.forEach(it => {
    if (it.sep) { menu.appendChild(el('div', 'sep')); return; }
    const b = el('button', it.danger ? 'danger' : '', esc(it.label));
    b.onclick = () => { hideCtx(); it.fn(); };
    menu.appendChild(b);
  });
  ctxOpenEvent = e;
  menu.classList.add('show');
  const r = menu.getBoundingClientRect();
  const x = Math.min(e.clientX, window.innerWidth - r.width - 12);
  const y = Math.min(e.clientY, window.innerHeight - r.height - 12);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}
const hideCtx = () => { ctxOpenEvent = null; $('ctx-menu').classList.remove('show'); };
document.addEventListener('click', e => {
  if (e === ctxOpenEvent) { ctxOpenEvent = null; return; } // ignore the click that opened it
  if (!$('ctx-menu').contains(e.target)) hideCtx();
});
window.addEventListener('resize', hideCtx);

// ── Open / close chat ──────────────────────────────────────────────────
function activeChat() { return chats.find(c => c.id === activeId) || null; }

function openChat(chatId) {
  activeId = chatId;
  replyTo = null; setReplyBar(null);
  clearPendingFile();
  $('intro-pane').style.display = 'none';
  $('chat-panel').style.display = 'flex';
  document.body.classList.add('chat-open');
  renderChatList();
  updateHeaderForActive();

  socket.emit('chat:open', { chatId }, res => {
    if (res?.error) return toast(res.error);
    if (activeId !== chatId) return;
    messages = res.messages || [];
    renderMessages();
    scrollBottom(true);
    $('msg-input').focus();
  });
}

function closeChat() {
  activeId = null;
  messages = [];
  $('chat-panel').style.display = 'none';
  $('intro-pane').style.display = 'flex';
  $('drawer').classList.remove('open');
  document.body.classList.remove('chat-open');
  renderChatList();
}

function setPeerStatus(text, typing) {
  $('peer-status').textContent = text;
  $('peer-status').classList.toggle('typing', !!typing);
}

function updateHeaderForActive() {
  const c = activeChat();
  if (!c) return;
  const entity = c.type === 'dm' ? (c.peer || { username: c.name }) : { name: c.name, type: 'group' };
  setAvatar('peer-avatar', entity, 40, c.type === 'dm');
  $('peer-name').textContent = c.name;

  const typing = typingUsers.get(c.id);
  if (typing && typing.size) {
    const names = [...typing.values()].map(t => t.name);
    setPeerStatus(c.type === 'group' ? `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} typing…` : 'typing…', true);
  } else if (c.type === 'dm') {
    const peer = users.find(u => u.id === c.peer?.id) || c.peer;
    setPeerStatus(lastSeenText(peer));
  } else {
    const names = c.members.map(id => (id === me.id ? 'You' : users.find(u => u.id === id)?.username)).filter(Boolean);
    setPeerStatus(names.join(', '));
  }
  renderChatList();
}

// ── Messages ───────────────────────────────────────────────────────────
function nearBottom() {
  const box = $('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}
function scrollBottom(instant) {
  const box = $('messages');
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  $('jump-btn').classList.remove('show');
  $('jump-n').style.display = 'none';
}
function bumpJump() {
  const n = $('jump-n');
  n.style.display = 'grid';
  n.textContent = (parseInt(n.textContent) || 0) + 1;
  $('jump-btn').classList.add('show');
}

function renderMessages() {
  const box = $('messages');
  const prevTop = box.scrollTop, prevH = box.scrollHeight;
  box.innerHTML = '';

  if (!messages.length) {
    const c = activeChat();
    box.appendChild(el('div', 'system-msg', `<span>${c?.type === 'group'
      ? 'This is the beginning of the group. Say something!'
      : 'No messages yet — send the first one 👋'}</span>`));
    return;
  }

  let lastDay = '', prevSender = null, prevTs = 0;
  messages.forEach(m => {
    const day = dayLabel(m.timestamp);
    if (day !== lastDay) {
      box.appendChild(el('div', 'day-divider', `<span>${day}</span>`));
      lastDay = day;
      prevSender = null;
    }
    if (m.type === 'system') {
      box.appendChild(el('div', 'system-msg', `<span>${esc(m.text)}</span>`));
      prevSender = null;
      return;
    }
    const grouped = prevSender === m.senderId && (m.timestamp - prevTs) < 5 * 60 * 1000;
    box.appendChild(messageRow(m, grouped));
    prevSender = m.senderId;
    prevTs = m.timestamp;
  });

  if (prevTop > 0) box.scrollTop = prevTop + (box.scrollHeight - prevH);
}

function messageRow(m, grouped) {
  const out = m.senderId === me.id;
  const c = activeChat();
  const row = el('div', `msg-row ${out ? 'out' : 'in'}${grouped ? ' grouped' : ''}`);
  row.dataset.id = m.id;

  let inner = '';

  if (m.deleted) {
    inner = `<div class="txt">${icon('close', 'icon-sm')} This message was deleted</div>`;
  } else {
    if (!out && c?.type === 'group' && !grouped) {
      inner += `<div class="author" style="color:${m.sender?.color || colorFor(m.senderId)}">${esc(m.sender?.username || 'Unknown')}</div>`;
    }
    if (m.replyTo) {
      inner += `<div class="reply-quote" data-jump="${esc(m.replyTo.id)}">
        <div class="rq-body">
          <div class="rq-name">${esc(m.replyTo.senderId === me.id ? 'You' : m.replyTo.senderName)}</div>
          <div class="rq-text">${esc(m.replyTo.text || m.replyTo.preview || 'Attachment')}</div>
        </div></div>`;
    }
    if (m.file) {
      const t = m.file.mimeType || '';
      if (t.startsWith('image/')) {
        inner += `<img class="photo" src="${esc(m.file.url)}" alt="${esc(m.file.name)}" data-photo="${esc(m.file.url)}" data-name="${esc(m.file.name)}" />`;
      } else if (t.startsWith('video/')) {
        inner += `<video class="clip" src="${esc(m.file.url)}" controls preload="metadata"></video>`;
      } else if (m.file.voice) {
        inner += voiceHTML(m.file);
      } else if (t.startsWith('audio/')) {
        inner += `<audio src="${esc(m.file.url)}" controls preload="metadata"></audio>`;
      } else {
        inner += `<a class="file-card" href="${esc(m.file.url)}" target="_blank" rel="noopener" download>
          <span class="fc-icon">${icon('doc', 'icon-sm')}</span>
          <span><span class="fc-name">${esc(m.file.name)}</span><br><span class="fc-meta">${fileSize(m.file.size)} · ${esc((m.file.name.split('.').pop() || 'file'))}</span></span>
        </a>`;
      }
    }
    if (m.text) inner += `<div class="txt">${linkify(m.text)}</div>`;
  }

  const emojiOnly = !m.file && !m.deleted && isEmojiOnly(m.text);
  inner += `<span class="meta-line">${m.editedAt ? 'edited ' : ''}${timeOf(m.timestamp)} ${out ? tickHTML(m.status || 'sent') : ''}</span>`;

  const reactions = Object.entries(m.reactions || {});
  const reactHTML = reactions.length
    ? `<div class="reactions">${reactions.map(([e, ids]) =>
        `<span class="reaction-pill ${ids.includes(me.id) ? 'mine' : ''}" title="${esc(ids.map(id => users.find(u => u.id === id)?.username || '?').join(', '))}">${e}${ids.length > 1 ? ' ' + ids.length : ''}</span>`).join('')}</div>`
    : '';

  const bubble = el('div', `bubble${emojiOnly ? ' emoji-only' : ''}${m.deleted ? ' deleted' : ''}`, inner + reactHTML);

  const tools = el('div', 'msg-tools', `
    <button data-act="react" title="React">${icon('emoji', 'icon-sm')}</button>
    <button data-act="reply" title="Reply">${icon('reply', 'icon-sm')}</button>
    <button data-act="more" title="More">${icon('chevron', 'icon-sm')}</button>`);

  if (out) { row.appendChild(tools); row.appendChild(bubble); }
  else { row.appendChild(bubble); row.appendChild(tools); }

  tools.querySelector('[data-act=reply]').onclick = () => startReply(m);
  tools.querySelector('[data-act=react]').onclick = e => reactionMenu(e, m);
  tools.querySelector('[data-act=more]').onclick = e => messageMenu(e, m);
  row.oncontextmenu = e => { e.preventDefault(); messageMenu(e, m); };

  bubble.querySelectorAll('[data-voice]').forEach(wireVoice);
  bubble.querySelector('[data-photo]')?.addEventListener('click', ev => {
    openLightbox(ev.target.dataset.photo, ev.target.dataset.name);
  });
  bubble.querySelector('[data-jump]')?.addEventListener('click', ev => {
    const target = $('messages').querySelector(`[data-id="${ev.currentTarget.dataset.jump}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.querySelector('.bubble').style.transition = 'filter .3s';
      target.querySelector('.bubble').style.filter = 'brightness(.9)';
      setTimeout(() => { target.querySelector('.bubble').style.filter = ''; }, 700);
    }
  });

  return row;
}

function reactionMenu(e, m) {
  const emojis = ['👍','❤️','😂','😮','😢','🙏'].map(emoji => ({
    emoji, fn: () => socket.emit('message:react', { chatId: activeId, messageId: m.id, emoji }),
  }));
  showCtxMenu(e, [{ label: 'Reply', fn: () => startReply(m) }], emojis);
}

function messageMenu(e, m) {
  const out = m.senderId === me.id;
  const items = [{ label: 'Reply', fn: () => startReply(m) }];
  if (m.text && !m.deleted) items.push({ label: 'Copy text', fn: () => { navigator.clipboard?.writeText(m.text); toast('Copied'); } });
  if (out && m.text && !m.deleted) items.push({ label: 'Edit message', fn: () => editMessage(m) });
  if (m.file && !m.deleted) items.push({ label: 'Download', fn: () => { const a = document.createElement('a'); a.href = m.file.url; a.download = m.file.name; a.click(); } });
  items.push({ sep: true });
  items.push({ label: 'Delete for me', danger: true, fn: () => socket.emit('message:delete', { chatId: activeId, messageId: m.id, forEveryone: false }) });
  if (out && !m.deleted) items.push({ label: 'Delete for everyone', danger: true, fn: () => socket.emit('message:delete', { chatId: activeId, messageId: m.id, forEveryone: true }) });
  showCtxMenu(e, items, ['👍','❤️','😂','😮','😢','🙏'].map(emoji => ({ emoji, fn: () => socket.emit('message:react', { chatId: activeId, messageId: m.id, emoji }) })));
}

function editMessage(m) {
  const text = prompt('Edit message', m.text);
  if (text != null && text.trim() && text.trim() !== m.text) {
    socket.emit('message:edit', { chatId: activeId, messageId: m.id, text: text.trim() });
  }
}

// ── Reply bar ──────────────────────────────────────────────────────────
function startReply(m) {
  replyTo = {
    id: m.id,
    senderId: m.senderId,
    senderName: m.sender?.username || 'Unknown',
    text: m.text,
    preview: previewOf(m),
  };
  setReplyBar(replyTo);
  $('msg-input').focus();
}
function setReplyBar(r) {
  const bar = $('reply-bar');
  if (!r) { bar.classList.remove('show'); return; }
  $('rb-name').textContent = r.senderId === me.id ? 'You' : r.senderName;
  $('rb-text').textContent = r.text || r.preview;
  bar.classList.add('show');
}

// ── Composer ───────────────────────────────────────────────────────────
function updateSendBtn() {
  const has = $('msg-input').value.trim().length > 0 || !!pendingFile;
  $('btn-send').classList.toggle('ready', has);
  // Empty composer shows the mic; typing swaps it for send, like WhatsApp.
  $('composer').classList.toggle('has-text', has);
}

function sendMessage() {
  const input = $('msg-input');
  const text = input.value.trim();
  if ((!text && !pendingFile) || !activeId) return;

  socket.emit('message:send', {
    chatId: activeId,
    text,
    file: pendingFile,
    type: pendingFile ? (pendingFile.mimeType?.split('/')[0] || 'file') : 'text',
    replyTo,
  });

  input.value = '';
  input.style.height = 'auto';
  replyTo = null; setReplyBar(null);
  clearPendingFile();
  updateSendBtn();
  socket.emit('typing:stop', { chatId: activeId });
  $('emoji-panel').classList.remove('show');
}

function onInput() {
  const input = $('msg-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 100) + 'px';
  updateSendBtn();
  if (!activeId) return;
  socket.emit('typing:start', { chatId: activeId });
  clearTimeout(typingTimers[activeId]);
  typingTimers[activeId] = setTimeout(() => socket.emit('typing:stop', { chatId: activeId }), 1800);
}

/**
 * Shrink big photos before upload, the way WhatsApp does. A 12MP phone photo is
 * ~5MB of JPEG that nobody views above ~1600px in a chat bubble, so we redraw it
 * to fit and re-encode. Returns the original untouched if it is already small,
 * is not a bitmap we can safely re-encode (GIF animation, SVG), or if anything
 * in the canvas path fails — compression is an optimisation, never a blocker.
 */
const IMG_MAX_EDGE = 1600;      // longest side we keep
const IMG_QUALITY = 0.82;       // JPEG quality
const IMG_SKIP_BELOW = 200 * 1024;  // don't bother under 200KB

async function compressImage(file) {
  if (!file.type.startsWith('image/')) return file;
  // GIFs would lose animation; SVG is vector and tiny already.
  if (/gif|svg/.test(file.type)) return file;
  if (file.size < IMG_SKIP_BELOW) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const { width: w, height: h } = bitmap;
    const scale = Math.min(1, IMG_MAX_EDGE / Math.max(w, h));
    // Already small enough and re-encoding probably won't help a modern JPEG.
    if (scale === 1 && file.size < 1024 * 1024) { bitmap.close?.(); return file; }

    const cw = Math.round(w * scale), ch = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, cw, ch);
    bitmap.close?.();

    // PNGs with transparency must stay PNG or they get a black background.
    const keepPng = file.type === 'image/png' && hasAlpha(ctx, cw, ch);
    const outType = keepPng ? 'image/png' : 'image/jpeg';

    const blob = await new Promise(res => canvas.toBlob(res, outType, IMG_QUALITY));
    if (!blob || blob.size >= file.size) return file;   // no win, keep original

    const base = file.name.replace(/\.[^.]+$/, '');
    const ext = keepPng ? 'png' : 'jpg';
    return new File([blob], `${base}.${ext}`, { type: outType, lastModified: Date.now() });
  } catch {
    return file;   // canvas blocked, decode failed, out of memory — send as-is
  }
}

/** Sample the canvas for any non-opaque pixel. */
function hasAlpha(ctx, w, h) {
  try {
    const step = Math.max(1, Math.floor(Math.min(w, h) / 64));
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let y = 0; y < h; y += step)
      for (let x = 0; x < w; x += step)
        if (d[(y * w + x) * 4 + 3] < 255) return true;
    return false;
  } catch { return true; }   // tainted canvas — assume alpha, keep PNG
}

async function uploadFile(file) {
  const original = file.size;
  if (file.type.startsWith('image/')) {
    toast('Compressing…');
    file = await compressImage(file);
  }

  const fd = new FormData();
  fd.append('file', file);
  const saved = original - file.size;
  toast(saved > 50 * 1024 ? `Uploading… (saved ${fileSize(saved)})` : 'Uploading…');
  try {
    const res = await fetch('/api/messenger/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    pendingFile = data;
    $('fb-name').textContent = data.name;
    $('fb-size').textContent = fileSize(data.size);
    $('fb-thumb').innerHTML = data.mimeType?.startsWith('image/')
      ? `<img src="${data.url}" alt="" />`
      : (data.mimeType?.startsWith('video/') ? '🎥' : data.mimeType?.startsWith('audio/') ? '🎵' : '📄');
    $('file-bar').classList.add('show');
    updateSendBtn();
    $('msg-input').focus();
  } catch (err) {
    toast('Upload failed: ' + err.message);
  }
}

// ── Voice notes ────────────────────────────────────────────────────────
let rec = null;            // MediaRecorder
let recChunks = [];
let recStream = null;
let recTimer = null;
let recStart = 0;
let recCancelled = false;
let recAnalyser = null;
let recRaf = 0;
let recPeaks = [];         // amplitude samples, drawn as the live waveform

function recSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

/** Pick a container the browser can actually record. Safari only does mp4. */
function recMime() {
  const want = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return want.find(t => MediaRecorder.isTypeSupported?.(t)) || '';
}

async function startRecording() {
  if (rec || !activeId) return;
  if (!recSupported()) return toast('Recording is not supported in this browser');

  try {
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    // Denied, dismissed, or no mic attached.
    return toast(err.name === 'NotAllowedError'
      ? 'Microphone access denied'
      : 'No microphone found');
  }

  recCancelled = false;
  recChunks = [];
  recPeaks = [];
  const mime = recMime();
  try {
    rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  } catch {
    stopTracks();
    return toast('Recording is not supported in this browser');
  }

  rec.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
  rec.onstop = finishRecording;
  rec.start();

  recStart = Date.now();
  $('rec-time').textContent = '0:00';
  $('composer').classList.add('recording');
  recTimer = setInterval(tickRecording, 200);
  meterStart();
}

function tickRecording() {
  const secs = Math.floor((Date.now() - recStart) / 1000);
  $('rec-time').textContent = clockOf(secs);
  if (secs >= 300) { toast('Voice notes are capped at 5 minutes'); stopRecording(); }
}

/** Live input level → a scrolling bar waveform. */
function meterStart() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(recStream);
    recAnalyser = ctx.createAnalyser();
    recAnalyser.fftSize = 512;
    src.connect(recAnalyser);
    const buf = new Uint8Array(recAnalyser.frequencyBinCount);
    const wave = $('rec-wave');

    const draw = () => {
      if (!recAnalyser) return;
      recAnalyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      recPeaks.push(Math.min(1, peak / 90));
      if (recPeaks.length > 48) recPeaks.shift();
      wave.innerHTML = recPeaks
        .map(v => `<i style="height:${Math.max(10, v * 100)}%"></i>`).join('');
      recRaf = requestAnimationFrame(draw);
    };
    draw();
    recAnalyser._ctx = ctx;
  } catch { /* metering is decorative */ }
}

function meterStop() {
  cancelAnimationFrame(recRaf);
  try { recAnalyser?._ctx?.close(); } catch { /* already closed */ }
  recAnalyser = null;
  $('rec-wave').innerHTML = '';
}

function stopTracks() {
  recStream?.getTracks().forEach(t => t.stop());
  recStream = null;
}

function stopRecording() {
  if (!rec) return;
  clearInterval(recTimer);
  meterStop();
  try { rec.stop(); } catch { /* already stopped */ }
}

function cancelRecording() {
  if (!rec) return;
  recCancelled = true;
  stopRecording();
}

async function finishRecording() {
  const secs = Math.round((Date.now() - recStart) / 1000);
  const chunks = recChunks;
  const type = rec?.mimeType || 'audio/webm';
  rec = null; recChunks = [];
  stopTracks();
  $('composer').classList.remove('recording');

  if (recCancelled) return;
  if (secs < 1 || !chunks.length) return toast('Hold on — that was too short');

  const ext = /mp4/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
  const blob = new Blob(chunks, { type });
  const file = new File([blob], `voice-${Date.now()}.${ext}`, { type });

  // Voice notes send immediately — no preview step, like WhatsApp.
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/messenger/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    socket.emit('message:send', {
      chatId: activeId,
      text: '',
      file: { ...data, voice: true, duration: secs },
      type: 'voice',
      replyTo,
    });
    replyTo = null; setReplyBar(null);
  } catch (err) {
    toast('Could not send voice note: ' + err.message);
  }
}

function clockOf(secs) {
  const m = Math.floor(secs / 60), sec = secs % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * WhatsApp-style voice bubble: play/pause, a seekable bar and a running clock.
 * Wired up after the bubble is in the DOM.
 */
function voiceHTML(file) {
  return `<div class="voice" data-voice="${esc(file.url)}">
    <button class="v-play" type="button">${icon('play', 'icon-sm')}</button>
    <div class="v-track"><div class="v-fill"></div></div>
    <span class="v-time">${clockOf(file.duration || 0)}</span>
  </div>`;
}

function wireVoice(box) {
  const url = box.dataset.voice;
  const btn = box.querySelector('.v-play');
  const track = box.querySelector('.v-track');
  const fill = box.querySelector('.v-fill');
  const time = box.querySelector('.v-time');
  const total = time.textContent;
  let audio = null;

  const setIcon = playing => { btn.innerHTML = icon(playing ? 'pause' : 'play', 'icon-sm'); };

  btn.onclick = () => {
    if (!audio) {
      audio = new Audio(url);
      audio.preload = 'metadata';
      audio.ontimeupdate = () => {
        if (!audio.duration || !isFinite(audio.duration)) return;
        fill.style.width = (audio.currentTime / audio.duration) * 100 + '%';
        time.textContent = clockOf(Math.floor(audio.currentTime));
      };
      audio.onended = () => { setIcon(false); fill.style.width = '0%'; time.textContent = total; };
      audio.onpause = () => setIcon(false);
      audio.onplay = () => setIcon(true);
    }
    if (audio.paused) {
      // Only one voice note at a time.
      document.querySelectorAll('audio').forEach(a => a !== audio && a.pause());
      audio.play().catch(() => toast('Could not play this clip'));
    } else audio.pause();
  };

  track.onclick = e => {
    if (!audio || !audio.duration || !isFinite(audio.duration)) return;
    const r = track.getBoundingClientRect();
    audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
  };
}

function clearPendingFile() {
  pendingFile = null;
  $('file-bar').classList.remove('show');
  $('file-input').value = '';
  updateSendBtn();
}

// ── Emoji panel ────────────────────────────────────────────────────────
function buildEmojiPanel() {
  const p = $('emoji-panel');
  p.innerHTML = '';
  for (const [group, list] of Object.entries(EMOJI_GROUPS)) {
    p.appendChild(el('div', 'grp-title', group));
    const grid = el('div', 'grid');
    list.forEach(e => {
      const b = el('button', '', e);
      b.onclick = () => {
        const input = $('msg-input');
        input.value += e;
        input.focus();
        updateSendBtn();
      };
      grid.appendChild(b);
    });
    p.appendChild(grid);
  }
}

// ── Drawer (contact / group info) ──────────────────────────────────────
function openDrawer() {
  const c = activeChat();
  if (!c) return;
  const body = $('drawer-body');
  body.innerHTML = '';
  $('drawer-title').textContent = c.type === 'group' ? 'Group info' : 'Contact info';

  const entity = c.type === 'dm' ? (users.find(u => u.id === c.peer?.id) || c.peer) : { name: c.name, type: 'group', id: c.id };
  const head = el('div', 'drawer-block', `
    ${avatarHTML(entity, 140)}
    <h3>${esc(c.name)}</h3>
    <div class="sub">${c.type === 'group'
      ? `Group · ${c.members.length} participant${c.members.length === 1 ? '' : 's'}`
      : esc(lastSeenText(entity))}</div>`);
  head.querySelector('.avatar').style.margin = '0 auto';
  body.appendChild(head);

  if (c.type === 'dm') {
    body.appendChild(el('div', 'drawer-block left', `
      <div class="drawer-label">About</div>
      <div class="drawer-value">${esc(entity?.about || 'Hey there! I am using VChat.')}</div>`));
    if (entity?.phone) {
      body.appendChild(el('div', 'drawer-block left', `
        <div class="drawer-label">Phone number</div>
        <div class="drawer-value">${esc(entity.phone)}</div>`));
    }
  } else {
    const members = el('div', 'drawer-block left');
    members.style.padding = '14px 0';
    members.appendChild(el('div', '', `<div class="drawer-label" style="padding:0 22px 8px">${c.members.length} participants</div>`));
    c.members.forEach(id => {
      const u = users.find(x => x.id === id);
      if (!u) return;
      const row = el('div', 'member-row', `
        ${avatarHTML(u, 40, true)}
        <div class="mr-name">${esc(u.id === me.id ? 'You' : u.username)}<div style="font-size:12.5px;color:var(--text-secondary)">${esc(u.about || '')}</div></div>
        ${c.createdBy === u.id ? '<span class="mr-tag">Admin</span>' : ''}`);
      if (u.id !== me.id) row.onclick = () => socket.emit('chat:startDM', { targetUserId: u.id }, r => r?.chat && openChat(r.chat.id));
      members.appendChild(row);
    });
    const add = el('button', 'drawer-action', `<span style="color:var(--wa-green)">${icon('group')}</span> Add participants`);
    add.onclick = () => openAddMembers(c);
    members.appendChild(add);
    body.appendChild(members);
  }

  const actions = el('div', '');
  const mute = el('button', 'drawer-action', `${icon('mute')} ${c.muted ? 'Unmute notifications' : 'Mute notifications'}`);
  mute.onclick = () => { socket.emit('chat:flag', { chatId: c.id, flag: 'muted', value: !c.muted }); setTimeout(openDrawer, 150); };
  const pin = el('button', 'drawer-action', `${icon('pin')} ${c.pinned ? 'Unpin chat' : 'Pin chat'}`);
  pin.onclick = () => { socket.emit('chat:flag', { chatId: c.id, flag: 'pinned', value: !c.pinned }); setTimeout(openDrawer, 150); };
  const clear = el('button', 'drawer-action danger', `${icon('trash')} Clear messages`);
  clear.onclick = () => { if (confirm('Clear all messages in this chat?')) socket.emit('chat:clear', { chatId: c.id }); };
  actions.append(mute, pin, clear);
  if (c.id !== 'general') {
    const leave = el('button', 'drawer-action danger', `${icon('logout')} ${c.type === 'group' ? 'Exit group' : 'Delete chat'}`);
    leave.onclick = () => { if (confirm('Are you sure?')) { socket.emit('chat:leave', { chatId: c.id }); $('drawer').classList.remove('open'); } };
    actions.appendChild(leave);
  }
  body.appendChild(actions);

  $('drawer').classList.add('open');
}
function refreshDrawerIfOpen() { if ($('drawer').classList.contains('open')) openDrawer(); }

// ── Modals ─────────────────────────────────────────────────────────────
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }
document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('show'); });
  o.querySelectorAll('[data-close]').forEach(b => b.onclick = () => o.classList.remove('show'));
});

function openNewChat() {
  const render = (q = '') => {
    const box = $('newchat-list');
    box.innerHTML = '';
    const list = users.filter(u => u.id !== me.id && u.username.toLowerCase().includes(q.toLowerCase()));
    if (!list.length) { box.innerHTML = '<div class="empty-list">No other people online yet.<br>Open a second browser window with another name.</div>'; return; }
    list.forEach(u => {
      const row = el('div', 'pick-row', `${avatarHTML(u, 40, true)}<div class="pk-name">${esc(u.username)}<div style="font-size:12.5px;color:var(--text-secondary)">${esc(u.about || '')}</div></div>`);
      row.onclick = () => socket.emit('chat:startDM', { targetUserId: u.id }, res => { closeModal('modal-newchat'); if (res?.chat) openChat(res.chat.id); });
      box.appendChild(row);
    });
  };
  $('newchat-search').value = '';
  $('newchat-search').oninput = e => render(e.target.value);
  render();
  openModal('modal-newchat');
}

function openNewGroup() {
  const picked = new Set();
  const renderList = () => {
    const box = $('group-list');
    box.innerHTML = '';
    const others = users.filter(u => u.id !== me.id);
    if (!others.length) { box.innerHTML = '<div class="empty-list">No other people yet.</div>'; return; }
    others.forEach(u => {
      const row = el('label', 'pick-row', `${avatarHTML(u, 40, true)}<div class="pk-name">${esc(u.username)}</div><input type="checkbox" ${picked.has(u.id) ? 'checked' : ''} />`);
      row.querySelector('input').onchange = e => {
        e.target.checked ? picked.add(u.id) : picked.delete(u.id);
        renderChips();
      };
      box.appendChild(row);
    });
  };
  const renderChips = () => {
    const box = $('group-chips');
    box.innerHTML = '';
    [...picked].forEach(id => {
      const u = users.find(x => x.id === id);
      if (!u) return;
      const chip = el('span', 'sc', `${avatarHTML(u, 32)}<span>${esc(u.username)}</span>`);
      chip.onclick = () => { picked.delete(id); renderChips(); renderList(); };
      box.appendChild(chip);
    });
  };
  $('group-name').value = '';
  renderList(); renderChips();
  $('group-create').onclick = () => {
    const name = $('group-name').value.trim();
    if (!name) return toast('Enter a group name');
    socket.emit('chat:createGroup', { name, members: [...picked] }, res => {
      closeModal('modal-group');
      if (res?.chat) openChat(res.chat.id);
    });
  };
  openModal('modal-group');
}

function openAddMembers(c) {
  const picked = new Set();
  const box = $('addmembers-list');
  box.innerHTML = '';
  const candidates = users.filter(u => !c.members.includes(u.id));
  if (!candidates.length) box.innerHTML = '<div class="empty-list">Everyone is already in this group.</div>';
  candidates.forEach(u => {
    const row = el('label', 'pick-row', `${avatarHTML(u, 40, true)}<div class="pk-name">${esc(u.username)}</div><input type="checkbox" />`);
    row.querySelector('input').onchange = e => e.target.checked ? picked.add(u.id) : picked.delete(u.id);
    box.appendChild(row);
  });
  $('addmembers-save').onclick = () => {
    if (picked.size) socket.emit('chat:addMembers', { chatId: c.id, members: [...picked] });
    closeModal('modal-addmembers');
  };
  openModal('modal-addmembers');
}

// ── Lightbox ───────────────────────────────────────────────────────────
function openLightbox(url, name) {
  $('lb-img').src = url;
  $('lb-name').textContent = name || '';
  $('lb-download').href = url;
  $('lb-download').download = name || 'image';
  $('lightbox').classList.add('show');
}
$('lb-close').onclick = () => $('lightbox').classList.remove('show');
$('lightbox').onclick = e => { if (e.target.id === 'lightbox') $('lightbox').classList.remove('show'); };

// ── In-chat search ─────────────────────────────────────────────────────
function runGlobalSearch(q) {
  socket.emit('search:messages', { query: q }, results => {
    const box = $('chat-list');
    if (!results.length) return;
    box.appendChild(el('div', 'list-section-title', `Messages (${results.length})`));
    results.forEach(r => {
      const hl = esc(r.message.text).replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>');
      const row = el('div', 'search-result', `
        <div class="sr-top"><span class="sr-name">${esc(r.chat.name)}</span><span>${rowTime(r.message.timestamp)}</span></div>
        <div class="sr-text">${r.message.senderId === me.id ? 'You: ' : esc(r.message.sender?.username || '') + ': '}${hl}</div>`);
      row.onclick = () => { $('search-input').value = ''; searchQuery = ''; openChat(r.chat.id); };
      box.appendChild(row);
    });
  });
}

// ── Main menu ──────────────────────────────────────────────────────────
function mainMenu(e) {
  showCtxMenu(e, [
    { label: 'New group', fn: openNewGroup },
    { label: 'Profile', fn: openProfile },
    { label: 'Archived', fn: () => setFilter('archived') },
    { sep: true },
    { label: document.body.classList.contains('dark') ? 'Light mode' : 'Dark mode', fn: toggleTheme },
    { sep: true },
    { label: 'Log out', danger: true, fn: async () => {
      const token = localStorage.getItem('vchat.token');
      localStorage.removeItem('vchat.token');
      try { await api('/api/auth/logout', { token }); } catch { /* offline */ }
      location.reload();
    } },
  ]);
}

function chatMenu(e) {
  const c = activeChat();
  if (!c) return;
  showCtxMenu(e, [
    { label: c.type === 'group' ? 'Group info' : 'Contact info', fn: openDrawer },
    { label: c.muted ? 'Unmute notifications' : 'Mute notifications', fn: () => socket.emit('chat:flag', { chatId: c.id, flag: 'muted', value: !c.muted }) },
    { label: c.archived ? 'Unarchive chat' : 'Archive chat', fn: () => { socket.emit('chat:flag', { chatId: c.id, flag: 'archived', value: !c.archived }); closeChat(); } },
    { sep: true },
    { label: 'Clear messages', danger: true, fn: () => { if (confirm('Clear all messages?')) socket.emit('chat:clear', { chatId: c.id }); } },
    ...(c.id !== 'general' ? [{ label: c.type === 'group' ? 'Exit group' : 'Delete chat', danger: true, fn: () => { if (confirm('Are you sure?')) socket.emit('chat:leave', { chatId: c.id }); } }] : []),
  ]);
}

function setFilter(f) {
  filter = f;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.filter === f));
  renderChatList();
}

function toggleTheme() {
  document.body.classList.toggle('dark');
  localStorage.setItem('vchat.theme', document.body.classList.contains('dark') ? 'dark' : 'light');
}

// ── Wiring ─────────────────────────────────────────────────────────────
function wire() {
  $('btn-new-chat').onclick = openNewChat;
  $('btn-new-group').onclick = openNewGroup;
  $('btn-menu').onclick = mainMenu;
  $('btn-back').onclick = closeChat;
  $('btn-chat-menu').onclick = chatMenu;
  $('btn-chat-search').onclick = () => { $('search-input').focus(); if (window.innerWidth <= 900) closeChat(); };
  $('peer-open').onclick = openDrawer;
  $('drawer-close').onclick = () => $('drawer').classList.remove('open');

  $('search-input').oninput = e => {
    searchQuery = e.target.value.trim();
    renderChatList();
    if (searchQuery.length >= 2) runGlobalSearch(searchQuery);
  };

  document.querySelectorAll('.chip').forEach(c => c.onclick = () => setFilter(c.dataset.filter));

  $('msg-input').addEventListener('input', onInput);
  $('msg-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    if (e.key === 'Escape') { replyTo = null; setReplyBar(null); }
  });
  $('btn-send').onclick = sendMessage;
  $('btn-mic').onclick = startRecording;
  $('rec-send').onclick = stopRecording;
  $('rec-cancel').onclick = cancelRecording;
  if (!recSupported()) $('btn-mic').style.display = 'none';
  $('rb-close').onclick = () => { replyTo = null; setReplyBar(null); };
  $('fb-close').onclick = clearPendingFile;

  $('btn-emoji').onclick = e => {
    e.stopPropagation();
    $('attach-menu').classList.remove('show');
    $('emoji-panel').classList.toggle('show');
  };
  $('btn-attach').onclick = e => {
    e.stopPropagation();
    $('emoji-panel').classList.remove('show');
    $('attach-menu').classList.toggle('show');
  };
  document.addEventListener('click', e => {
    if (!$('emoji-panel').contains(e.target) && e.target.closest('#btn-emoji') === null) $('emoji-panel').classList.remove('show');
    if (!$('attach-menu').contains(e.target) && e.target.closest('#btn-attach') === null) $('attach-menu').classList.remove('show');
  });

  $('attach-menu').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      $('file-input').accept = b.dataset.accept || '';
      $('attach-menu').classList.remove('show');
      $('file-input').click();
    };
  });
  $('file-input').onchange = e => { const f = e.target.files[0]; if (f) uploadFile(f); };

  $('messages').addEventListener('scroll', () => {
    if (nearBottom()) { $('jump-btn').classList.remove('show'); $('jump-n').style.display = 'none'; $('jump-n').textContent = ''; }
    else $('jump-btn').classList.add('show');
  });
  $('jump-btn').onclick = () => { scrollBottom(); $('jump-n').textContent = ''; };

  // drag & drop upload
  const panel = $('chat-panel');
  ['dragover', 'drop'].forEach(ev => panel.addEventListener(ev, e => e.preventDefault()));
  panel.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) uploadFile(f); });

  // paste images
  document.addEventListener('paste', e => {
    if (!activeId) return;
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) uploadFile(item.getAsFile());
  });

  buildEmojiPanel();
}

// ── Boot ───────────────────────────────────────────────────────────────
initLogin();
wire();

})();
