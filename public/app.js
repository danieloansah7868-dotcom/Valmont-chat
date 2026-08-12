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
let reels = [];
let reelsCursor = null;
let reelsLoading = false;
let reelsReloadPending = false;
let reelsExhausted = false;
let reelsObserver = null;
let reelsRefreshTimer = null;
let reelMaxBytes = 50 * 1024 * 1024;
let reelUploadFile = null;
let reelUploadPreviewUrl = null;
let reelUploadAbort = null;
let reelUploadCleanup = null;
let storyGroups = [];
let storyAds = [];
let storySequence = [];
let storyIndex = -1;
let storyPlayback = null;
let storiesLoading = false;
let storiesRefreshTimer = null;
let storyMaxBytes = 30 * 1024 * 1024;
let storyReactions = ['❤️', '😂', '😮', '😢', '👏', '🔥'];
let storyFile = null;
let storyPreviewUrl = null;
let storyBackground = 'jade';
let storyPublishing = false;
let storyUploadRequest = null;
let storyPaymentConfigured = false;
let storyAdAdmin = false;

const AVATARS = ['😀','😎','🦊','🐼','🐯','🦁','🐸','🐵','🦄','🐙','🌟','🚀','🔥','🍀','🎧','⚽','🎸','🌺','🍕','🐨'];
const NOTIFICATION_DEFAULTS = {
  desktop: false,
  previews: true,
  messageSounds: true,
  messageTone: 'chime',
  callSounds: true,
  ringtone: 'classic',
  mediaVisibility: 'show',
};
let notificationPrefs = { ...NOTIFICATION_DEFAULTS };
try {
  notificationPrefs = { ...NOTIFICATION_DEFAULTS, ...JSON.parse(localStorage.getItem('vchat.notifications') || '{}') };
} catch { /* corrupted local settings fall back safely */ }

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
  const palette = ['#0b1f3a','#16325c','#d9772a','#f0b56a','#a85a18','#4a5870','#d3396d','#5157ae','#bf59cf','#e542a3'];
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}
const isEmojiOnly = t => t && /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f\s]+$/u.test(t) && [...t.replace(/\s/g, '')].length <= 6;

function formatMessage(text) {
  const blocks = [];
  let source = String(text || '').replace(/```([\s\S]*?)```/g, (_match, code) => {
    blocks.push(`<pre class="msg-code">${esc(code.trim())}</pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });
  source = source.replace(/`([^`\n]+)`/g, (_match, code) => {
    blocks.push(`<code>${esc(code)}</code>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });
  let html = esc(source);
  html = html
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,!?;:]|$)/g, '$1<strong>$2</strong>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|[.,!?;:]|$)/g, '$1<em>$2</em>')
    .replace(/(^|\s)~([^~\n]+)~(?=\s|[.,!?;:]|$)/g, '$1<del>$2</del>')
    .replace(/(https?:\/\/[^\s<]+)/g, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/(^|\s)(@[\p{L}\p{N}_.-]{2,40})/gu, '$1<span class="mention">$2</span>');
  html = html.split('\n').map(line => {
    if (/^&gt;\s/.test(line)) return `<blockquote>${line.replace(/^&gt;\s?/, '')}</blockquote>`;
    if (/^[-•]\s/.test(line)) return `<div class="msg-list-item">• ${line.replace(/^[-•]\s?/, '')}</div>`;
    return line;
  }).join('<br>');
  return html.replace(/\u0000BLOCK(\d+)\u0000/g, (_match, index) => blocks[Number(index)] || '');
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
  const photoUrl = entity?.photoUrl;
  const bg = entity?.color || colorFor(entity?.id || name);
  const inner = photoUrl
    ? `<img class="avatar-photo" src="${esc(photoUrl)}" alt="" loading="lazy">`
    : (emoji ? esc(emoji) : (entity?.type === 'group' ? icon('group', 'icon') : esc(initials(name))));
  const dot = showPresence ? `<span class="presence ${entity?.status === 'online' ? 'on' : ''}"></span>` : '';
  return `<div class="avatar sz-${size}" style="background:${photoUrl || emoji ? 'var(--panel-alt)' : bg}">${inner}${dot}</div>`;
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
  if (m.type === 'call') {
    const info = m.call || {};
    const kind = info.media === 'video' ? '📹' : '📞';
    if (info.outcome === 'missed') return `${kind} Missed call`;
    if (info.outcome === 'declined') return `${kind} Call declined`;
    return `${kind} Call · ${clockOf(info.duration || 0)}`;
  }
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

async function api(path, body, options = {}) {
  const method = options.method || (body === undefined ? 'GET' : 'POST');
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
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

/** Silently resume the server-held HttpOnly session cookie. */
async function restoreSession() {
  // Remove pre-security-release bearer tokens; they are intentionally invalid.
  localStorage.removeItem('vchat.token');
  const { ok, data } = await api('/api/auth/session');
  if (ok && data.user) connect();
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
  if (data.needsTwoStep) {
    const pin = prompt('Enter your 6-digit two-step verification PIN');
    if (!pin) return;
    const result = await api('/api/auth/two-step', { phone: authPhone, pin });
    if (!result.ok) {
      $('code-err').textContent = result.data.error || 'Incorrect PIN';
      return;
    }
    finishAuth(result.data);
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

function finishAuth({ user }) {
  localStorage.setItem('vchat.name', user.username);
  localStorage.setItem('vchat.avatar', user.avatar || '');
  connect();
}

// ── Socket ─────────────────────────────────────────────────────────────
function connect() {
  if (socket) socket.close();
  socket = io({ transports: ['websocket', 'polling'], withCredentials: true });

  socket.on('connect', () => {
    socket.emit('user:join', {}, (res) => {
      $('login-btn').disabled = false;
      if (!res || res.error) {
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
      updateOfflineBar();
      flushOutbox();
      refreshIceServers();
      verifyReturnedBoostPayment().catch(() => {});
      const invite = new URLSearchParams(location.search).get('invite');
      if (invite) {
        socket.emit('chat:joinInvite', { code: invite }, result => {
          if (result?.chat) {
            history.replaceState({}, '', location.pathname);
            openChat(result.chat.id);
            toast(`Joined ${result.chat.name}`);
          } else toast(result?.error || 'Invite link is invalid');
        });
      }
    });
  });

  socket.on('session:revoked', () => {
    socket.close();
    closeModal('modal-reel-upload');
    closeModal('modal-story-compose');
    closeStories();
    closeReels();
    reels = [];
    $('reels-feed').innerHTML = '';
    $('login').style.display = '';
    document.body.classList.remove('ready');
    showStep('step-phone');
    $('login-err').textContent = 'This device was signed out from your account.';
  });

  socket.on('connect_error', error => {
    if (/Authentication required/i.test(error?.message || '')) {
      socket.close();
      $('login').style.display = '';
      document.body.classList.remove('ready');
      showStep('step-phone');
      $('login-err').textContent = 'Your session expired. Please sign in again.';
    }
  });

  socket.on('disconnect', () => {
    setPeerStatus('connecting…');
    // No point counting down a retry while there is nothing to retry over.
    clearTimeout(retryTimer); retryTimer = null;
    updateOfflineBar();
  });

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
  socket.on('reels:changed', () => {
    if (!document.body.classList.contains('reels-open')) return;
    clearTimeout(reelsRefreshTimer);
    reelsRefreshTimer = setTimeout(() => loadReels(true, true), 350);
  });
  socket.on('stories:changed', () => {
    if (!$('stories-screen').classList.contains('open')) {
      $('story-notice').hidden = false;
      return;
    }
    if (!$('story-viewer').hidden) return;
    clearTimeout(storiesRefreshTimer);
    storiesRefreshTimer = setTimeout(() => loadStories({ quiet: true }), 350);
  });

  socket.on('call:incoming', onCallIncoming);
  socket.on('call:accepted', onCallAccepted);
  socket.on('call:ended', onCallEnded);
  socket.on('call:signal', onCallSignal);

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
    // Our own message coming back: the queued copy has served its purpose,
    // whether or not we ever saw the acknowledgement.
    if (m.senderId === me.id && m.clientId) {
      const q = outbox.findIndex(i => i.clientId === m.clientId);
      if (q !== -1) { outbox.splice(q, 1); saveOutbox(); updateOfflineBar(); }
      const at = messages.findIndex(x => x.id === m.clientId);
      if (at !== -1) messages.splice(at, 1);
    }
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
    if (m.senderId !== me.id && document.hidden) {
      const c = chats.find(x => x.id === m.chatId);
      if (!c?.muted) {
        if (m.chatId === activeId) ping();
        showMessageNotification(m, c);
      }
      notifyTitle();
    }
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
let activeCallNotification = null;
function ping(force = false) {
  if (!force && !notificationPrefs.messageSounds) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume?.();
    const tones = {
      chime: [880, 1175],
      soft: [520, 660],
      bright: [990, 1320],
    };
    const notes = tones[notificationPrefs.messageTone] || tones.chime;
    notes.forEach((frequency, index) => {
      const start = audioCtx.currentTime + index * 0.13;
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.frequency.value = frequency; o.type = notificationPrefs.messageTone === 'soft' ? 'sine' : 'triangle';
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.045, start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
      o.start(start); o.stop(start + 0.21);
    });
  } catch (_) {}
}

function showMessageNotification(message, chat) {
  if (!notificationPrefs.desktop || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  const privatePreview = chat?.advancedPrivacy || !notificationPrefs.previews;
  const sender = message.sender?.username || chat?.name || 'Vchat';
  const title = privatePreview ? 'New Vchat message' : (chat?.type === 'group' ? `${sender} · ${chat.name}` : sender);
  const body = privatePreview ? 'Open Vchat to read it' : previewOf(message);
  try {
    const notice = new Notification(title, { body, icon: '/icons/icon-192.png', tag: `chat-${message.chatId}` });
    notice.onclick = () => { window.focus(); openChat(message.chatId); notice.close(); };
  } catch { /* browser or OS declined the notification */ }
}

function showCallNotification(from, media) {
  if (!notificationPrefs.desktop || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    activeCallNotification?.close();
    activeCallNotification = new Notification(`Incoming ${media === 'video' ? 'video' : 'voice'} call`, {
      body: notificationPrefs.previews ? (from?.username || 'Vchat contact') : 'Open Vchat to answer',
      icon: '/icons/icon-192.png', tag: 'vchat-incoming-call', requireInteraction: true,
    });
    activeCallNotification.onclick = () => { window.focus(); activeCallNotification?.close(); };
  } catch { /* unsupported notification options */ }
}
function closeCallNotification() {
  activeCallNotification?.close();
  activeCallNotification = null;
}

function notifyTitle() {
  unseen++;
  document.title = `(${unseen}) VChat`;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseReelVideos();
  else {
    unseen = 0;
    document.title = 'VChat';
    if (document.body.classList.contains('reels-open') && reelAutoplayEnabled()) {
      const current = $('reels-feed')?.querySelector(`[data-id="${visibleReelId() || ''}"] video`);
      current?.play().catch(() => {});
    }
  }
});

// ── Me / profile ───────────────────────────────────────────────────────
function renderMe() {
  const node = setAvatar('me-avatar', me, 40, false, 'me-avatar');
  if (node) { node.title = 'Profile'; node.onclick = openProfile; }
}

let profileModalCleanup = null;
function openProfile() {
  profileModalCleanup?.();
  setAvatar('profile-avatar', me, 140);
  let picked = me.avatar;
  let photoFile = null;
  let photoAction = 'keep';
  let previewUrl = null;

  const clearPreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  };
  const cleanup = () => {
    clearPreview();
    photoFile = null;
    if ($('profile-photo-input')) $('profile-photo-input').value = '';
    if (profileModalCleanup === cleanup) profileModalCleanup = null;
  };
  profileModalCleanup = cleanup;

  const showPhotoPreview = url => {
    const node = $('profile-avatar');
    node.innerHTML = `<img class="avatar-photo" src="${esc(url)}" alt="Profile photo preview">`;
    node.style.background = 'var(--panel-alt)';
  };

  buildAvatarPicker($('profile-avatar-picker'), me.avatar, a => {
    picked = a;
    clearPreview();
    photoFile = null;
    photoAction = me.photoUrl ? 'remove' : 'keep';
    const node = $('profile-avatar');
    node.textContent = a;
    node.style.background = 'var(--panel-alt)';
    $('profile-photo-remove').hidden = true;
  });

  $('profile-name').value = me.username;
  $('profile-about').value = me.about || '';
  $('profile-photo-input').value = '';
  $('profile-photo-remove').hidden = !me.photoUrl;
  $('profile-phone').textContent = me.phone || 'Not linked';

  $('profile-photo-choose').onclick = () => $('profile-photo-input').click();
  $('profile-photo-input').onchange = () => {
    const file = $('profile-photo-input').files?.[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type) || file.size > 5 * 1024 * 1024) {
      $('profile-photo-input').value = '';
      return toast('Choose a JPEG, PNG, or WebP image up to 5 MB');
    }
    clearPreview();
    previewUrl = URL.createObjectURL(file);
    photoFile = file;
    photoAction = 'upload';
    showPhotoPreview(previewUrl);
    $('profile-photo-remove').hidden = false;
  };
  $('profile-photo-remove').onclick = () => {
    clearPreview();
    photoFile = null;
    photoAction = 'remove';
    const node = $('profile-avatar');
    node.textContent = picked || initials(me.username);
    node.style.background = 'var(--panel-alt)';
    $('profile-photo-remove').hidden = true;
  };
  $('profile-name-emoji').onclick = event => {
    const input = $('profile-name');
    const emojis = ['😊','❤️','✨','🔥','👑','🌟','🎵','🌺','🦋','🚀','⚽','🎮'];
    showCtxMenu(event, emojis.map(emoji => ({ label: emoji, fn: () => {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.setRangeText(emoji, start, end, 'end');
      input.focus();
    } })));
  };

  $('profile-save').onclick = async () => {
    const name = $('profile-name').value.trim();
    if (name.length < 2) return toast('Your name must be at least 2 characters');
    const button = $('profile-save');
    button.disabled = true;
    const profileResult = await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ error: 'Profile update timed out. Check your connection.' }), 10000);
      socket.emit('profile:update', {
        username: name,
        avatar: picked,
        about: $('profile-about').value.trim(),
      }, result => {
        clearTimeout(timer);
        resolve(result);
      });
    });
    if (profileResult?.error || !profileResult?.user) {
      button.disabled = false;
      return toast(profileResult?.error || 'Could not update profile');
    }

    const applyLocalProfile = user => {
      me = user;
      localStorage.setItem('vchat.name', me.username);
      localStorage.setItem('vchat.avatar', me.avatar || '');
      renderMe();
    };
    // Text/avatar details have committed even if the independent media request
    // below fails. Reflect that partial success instead of leaving stale UI.
    applyLocalProfile(profileResult.user);

    try {
      if (photoAction === 'upload' && photoFile) {
        const form = new FormData();
        form.append('photo', photoFile, photoFile.name);
        const response = await fetch('/api/account/profile-photo', {
          method: 'PUT', credentials: 'same-origin', body: form,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'the photo could not be uploaded');
        applyLocalProfile(data.user);
      } else if (photoAction === 'remove') {
        const result = await api('/api/account/profile-photo', {}, { method: 'DELETE' });
        if (!result.ok) throw new Error(result.data.error || 'the photo could not be removed');
        applyLocalProfile(result.data.user);
      }
    } catch (error) {
      button.disabled = false;
      return toast(`Profile details saved, but ${error.message}`);
    }

    button.disabled = false;
    closeModal('modal-profile');
    toast('Profile updated');
  };
  openModal('modal-profile');
}

// ── Chat list ──────────────────────────────────────────────────────────
function visibleChats() {
  let list = chats.slice();
  if (filter === 'unread') list = list.filter(c => c.unread > 0);
  else if (filter === 'favorites') list = list.filter(c => c.favorite && !c.archived);
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
          ${c.favorite ? `<span class="row-icon favorite">${icon('star', 'icon-sm')}</span>` : ''}
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
    { label: c.favorite ? 'Remove from Favorites' : 'Add to Favorites', fn: () => socket.emit('chat:flag', { chatId: c.id, flag: 'favorite', value: !c.favorite }) },
    { label: c.unread ? 'Mark as read' : 'Mark as unread', fn: () => c.unread
      ? socket.emit('messages:read', { chatId: c.id })
      : socket.emit('chat:flag', { chatId: c.id, flag: 'manualUnread', value: true }) },
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
function canSendTo(chat) {
  if (!chat || chat.type !== 'group' || chat.permissions?.sendMessages !== 'admins') return true;
  return (chat.admins || []).includes(me.id);
}
function updateComposerPermissions(chat) {
  const allowed = canSendTo(chat);
  $('composer').classList.toggle('read-only', !allowed);
  $('msg-input').disabled = !allowed;
  $('msg-input').placeholder = allowed ? 'Type a message' : 'Only group admins can send messages';
  for (const id of ['btn-emoji', 'btn-attach', 'btn-send', 'btn-mic']) $(id).disabled = !allowed;
  if (!allowed) {
    $('attach-menu').classList.remove('show');
    $('emoji-panel').classList.remove('show');
    clearPendingFile();
  }
}

function openChat(chatId) {
  activeId = chatId;
  replyTo = null; setReplyBar(null);
  clearPendingFile();
  $('intro-pane').style.display = 'none';
  $('chat-panel').style.display = 'flex';
  document.body.classList.add('chat-open');
  renderChatList();
  updateHeaderForActive();

  // Show anything still queued for this chat even before the server answers.
  messages = pendingFor(chatId);
  renderMessages();

  socket.emit('chat:open', { chatId }, res => {
    if (res?.error) return toast(res.error);
    if (activeId !== chatId) return;
    messages = [...(res.messages || []), ...pendingFor(chatId)];
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
  updateComposerPermissions(c);
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
  updateCallButtons();
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
  const row = el('div', `msg-row ${out ? 'out' : 'in'}${grouped ? ' grouped' : ''}${m.pending ? ' pending' : ''}${m.stuck ? ' stuck' : ''}`);
  row.dataset.id = m.id;

  let inner = '';

  if (m.deleted) {
    inner = `<div class="txt">${icon('close', 'icon-sm')} This message was deleted</div>`;
  } else if (m.type === 'call') {
    inner = callLogHTML(m);
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
      const t = m.file.mimeType || m.file.type || '';
      const protectedControls = c?.advancedPrivacy
        ? ' controlslist="nodownload noremoteplayback" disableremoteplayback'
        : '';
      if (t.startsWith('image/')) {
        // In lite mode a photo costs nothing until it is actually wanted.
        inner += ((lite || notificationPrefs.mediaVisibility === 'tap') && !shownPhotos.has(m.file.url))
          ? `<button class="photo-hold" data-load="${esc(m.file.url)}">
               <span class="ph-icon">${icon('photo', 'icon-sm')}</span>
               <span class="ph-label">Tap to load photo</span>
               <span class="ph-size">${fileSize(m.file.size)}</span>
             </button>`
          : `<img class="photo" src="${esc(m.file.url)}" alt="${esc(m.file.name)}" data-photo="${esc(m.file.url)}" data-name="${esc(m.file.name)}" />`;
      } else if (t.startsWith('video/')) {
        // preload="none" in lite mode: metadata alone can be hundreds of KB.
        inner += `<video class="clip" src="${esc(m.file.url)}" controls${protectedControls}${c?.advancedPrivacy ? ' disablepictureinpicture' : ''} preload="${lite ? 'none' : 'metadata'}"></video>`;
      } else if (m.file.voice) {
        inner += voiceHTML(m.file);
      } else if (t.startsWith('audio/')) {
        inner += `<audio src="${esc(m.file.url)}" controls${protectedControls} preload="metadata"></audio>`;
      } else {
        inner += `<a class="file-card" href="${esc(m.file.url)}" target="_blank" rel="noopener"${c?.advancedPrivacy ? '' : ' download'}>
          <span class="fc-icon">${icon('doc', 'icon-sm')}</span>
          <span><span class="fc-name">${esc(m.file.name)}</span><br><span class="fc-meta">${fileSize(m.file.size)} · ${esc((m.file.name.split('.').pop() || 'file'))}${c?.advancedPrivacy ? ' · protected chat' : ''}</span></span>
        </a>`;
      }
    }
    if (m.forwarded) inner += '<div class="forwarded">↪ Forwarded</div>';
    if (m.pinnedUntil && m.pinnedUntil > Date.now()) inner += '<div class="pinned-label">📌 Pinned</div>';
    if (m.text) inner += `<div class="txt">${formatMessage(m.text)}</div>`;
  }

  const emojiOnly = !m.file && !m.deleted && isEmojiOnly(m.text);
  if (m.stuck) inner += `<div class="stuck-note">${icon('clock', 'icon-sm')} Waiting for a connection</div>`;
  inner += `<span class="meta-line">${m.starred ? '★ ' : ''}${m.expiresAt ? '◷ ' : ''}${m.editedAt ? 'edited ' : ''}${timeOf(m.timestamp)} ${out ? tickHTML(m.status || 'sent') : ''}</span>`;

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
  bubble.querySelector('[data-load]')?.addEventListener('click', ev => {
    // Tapped a held-back photo: remember it and swap the placeholder for the image.
    shownPhotos.add(ev.currentTarget.dataset.load);
    renderMessages();
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
  // A queued message does not exist on the server yet, so editing, reacting
  // and deleting-for-everyone have nothing to act on. Offer what does work.
  if (m.pending) {
    const items = [];
    if (m.text) items.push({ label: 'Copy text', fn: () => { navigator.clipboard?.writeText(m.text); toast('Copied'); } });
    items.push({ label: 'Try sending now', fn: () => retryOutboxNow() });
    items.push({ sep: true });
    items.push({ label: 'Delete unsent message', danger: true, fn: () => discardQueued(m.id) });
    return showCtxMenu(e, items);
  }

  const out = m.senderId === me.id;
  const protectedChat = !!activeChat()?.advancedPrivacy;
  const items = [{ label: 'Reply', fn: () => startReply(m) }];
  if (!m.deleted) items.push({ label: m.starred ? 'Unstar' : 'Star', fn: () => socket.emit('message:star', { chatId: activeId, messageId: m.id }) });
  if (!m.deleted && !protectedChat) items.push({ label: 'Forward', fn: () => openForward(m) });
  if (!m.deleted) items.push({
    label: m.pinnedUntil && m.pinnedUntil > Date.now() ? 'Unpin message' : 'Pin for 24 hours',
    fn: () => socket.emit('message:pin', {
      chatId: activeId, messageId: m.id,
      durationSeconds: m.pinnedUntil && m.pinnedUntil > Date.now() ? 0 : 86400,
    }, result => result?.error && toast(result.error)),
  });
  if (m.text && !m.deleted) items.push({ label: 'Copy text', fn: () => { navigator.clipboard?.writeText(m.text); toast('Copied'); } });
  if (out && m.text && !m.deleted) items.push({ label: 'Edit message', fn: () => editMessage(m) });
  if (m.file && !m.deleted && !protectedChat) items.push({ label: 'Download', fn: () => downloadAttachment(m.file) });
  items.push({ sep: true });
  items.push({ label: 'Delete for me', danger: true, fn: () => socket.emit('message:delete', { chatId: activeId, messageId: m.id, forEveryone: false }) });
  if (out && !m.deleted) items.push({ label: 'Delete for everyone', danger: true, fn: () => socket.emit('message:delete', { chatId: activeId, messageId: m.id, forEveryone: true }) });
  showCtxMenu(e, items, ['👍','❤️','😂','😮','😢','🙏'].map(emoji => ({ emoji, fn: () => socket.emit('message:react', { chatId: activeId, messageId: m.id, emoji }) })));
}

async function downloadAttachment(file) {
  try {
    const response = await fetch(file.url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(response.status === 404 ? 'Attachment is unavailable' : 'Download failed');
    const href = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = href;
    link.download = file.name || 'attachment';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  } catch (error) {
    toast(error.message || 'Download failed');
  }
}

function editMessage(m) {
  const text = prompt('Edit message', m.text);
  if (text != null && text.trim() && text.trim() !== m.text) {
    socket.emit('message:edit', { chatId: activeId, messageId: m.id, text: text.trim() });
  }
}

function openForward(message) {
  const picked = new Set();
  const list = $('forward-list');
  list.innerHTML = '';
  chats.filter(chat => !chat.archived).forEach(chat => {
    const row = el('label', 'pick-row', `${avatarHTML(chat.type === 'dm' ? (chat.peer || { username: chat.name }) : { name: chat.name, type: 'group', id: chat.id }, 40)}<div class="pk-name">${esc(chat.name)}</div><input type="checkbox" />`);
    row.querySelector('input').onchange = event => {
      if (event.target.checked && picked.size >= 5) {
        event.target.checked = false;
        return toast('You can forward to up to 5 chats at once');
      }
      if (event.target.checked) picked.add(chat.id); else picked.delete(chat.id);
    };
    list.appendChild(row);
  });
  $('forward-send').onclick = () => {
    if (!picked.size) return toast('Choose at least one chat');
    socket.emit('message:forward', {
      chatId: message.chatId,
      messageId: message.id,
      targetChatIds: [...picked],
    }, result => {
      if (result?.error) return toast(result.error);
      closeModal('modal-forward');
      toast(`Forwarded to ${result?.count || 0} chat${result?.count === 1 ? '' : 's'}`);
    });
  };
  openModal('modal-forward');
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
  if (!canSendTo(activeChat())) return toast('Only group admins can send messages');

  const payload = {
    chatId: activeId,
    text,
    file: pendingFile,
    type: pendingFile ? (pendingFile.mimeType?.split('/')[0] || 'file') : 'text',
    replyTo,
  };
  // Everything goes through the outbox, connection or not. A message is only
  // dropped from it once the server has confirmed it, so a send that dies
  // halfway is retried instead of lost.
  queueMessage(payload);
  flushOutbox();

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

// ── Offline outbox ─────────────────────────────────────────────────────
/**
 * Messages written while there is no connection. They are kept in
 * localStorage so they survive a refresh, a dead battery or a closed tab,
 * shown in the thread with a clock tick, and flushed in order the moment the
 * socket comes back. Ten seconds of signal is enough to empty a day of
 * writing.
 */
const OUTBOX_KEY = 'vchat.outbox';
// A send is given this long to be acknowledged before we assume the phone lost
// signal mid-flight. Short enough to notice a dead bundle, long enough that a
// slow 2G round trip is not mistaken for failure.
const SEND_TIMEOUT_MS = 12000;
// Waits between retries. A phone that has run out of data gets a few quick
// tries, then we back off instead of burning battery on a dead radio.
const RETRY_BACKOFF_MS = [3000, 8000, 20000, 60000];
let outbox = [];
let flushing = false;
let retryTimer = null;
let inflight = null;     // resolver of the send we are currently waiting on
let flushAgain = false;

function loadOutbox() {
  try { outbox = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); }
  catch { outbox = []; }
  if (!Array.isArray(outbox)) outbox = [];
  // Nothing is mid-flight after a reload, however it ended.
  for (const i of outbox) i.sending = false;
}

function saveOutbox() {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox)); }
  catch { /* storage full or blocked — the queue stays in memory */ }
}

function online() { return !!socket && socket.connected; }

/** Queue a message and show it straight away. */
function queueMessage(payload) {
  const item = {
    ...payload,
    // Survives retries and reloads: the server uses it to recognise a message
    // it has already stored, so a retry can never post twice.
    clientId: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9),
    queuedAt: Date.now(),
    tries: 0,
  };
  item.tempId = item.clientId;
  outbox.push(item);
  saveOutbox();
  if (item.chatId === activeId) {
    messages.push(outboxToMessage(item));
    renderMessages();
    scrollBottom();
  }
  updateOfflineBar();
  return item;
}

/** Dress a queued item up as a message so the thread can render it. */
function outboxToMessage(item) {
  return {
    id: item.tempId,
    chatId: item.chatId,
    senderId: me.id,
    sender: { id: me.id, username: me.username, avatar: me.avatar, color: me.color },
    text: item.text || '',
    file: item.file || null,
    type: item.type || 'text',
    replyTo: item.replyTo || null,
    timestamp: item.queuedAt,
    reactions: {},
    status: 'pending',
    pending: true,
    // Shown only once a send has actually failed, so a message on its way
    // out does not flash a warning at someone whose connection is fine.
    stuck: !!item.failed,
  };
}

/** Anything queued for this chat, so opening it shows unsent messages too. */
function pendingFor(chatId) {
  return outbox.filter(i => i.chatId === chatId).map(outboxToMessage);
}

/** Replace a queued placeholder in the open thread with what the server stored. */
function settleQueued(tempId) {
  const at = messages.findIndex(m => m.id === tempId);
  if (at !== -1) { messages.splice(at, 1); renderMessages(); }
}

/** Redraw a placeholder after its state changed (e.g. it is now struggling). */
function refreshQueued(item) {
  if (item.chatId !== activeId) return;
  const at = messages.findIndex(m => m.id === item.tempId);
  if (at !== -1) { messages[at] = outboxToMessage(item); renderMessages(); }
}

/**
 * Send one queued message and wait for the server to confirm it.
 *
 * Resolves true only on a confirmed store. A timeout resolves false, which is
 * the case that matters: on a phone with no bundle left the socket often still
 * looks connected and the send simply vanishes.
 */
function sendQueued(item) {
  return new Promise(resolve => {
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      if (inflight === done) inflight = null;
      resolve(ok);
    };
    inflight = done;
    const bail = setTimeout(() => done(false), SEND_TIMEOUT_MS);
    try {
      socket.emit('message:send', {
        chatId: item.chatId,
        text: item.text,
        file: item.file,
        type: item.type,
        replyTo: item.replyTo,
        tempId: item.tempId,
        clientId: item.clientId,
      }, res => {
        clearTimeout(bail);
        // A rejection is permanent — retrying cannot fix a deleted chat.
        if (res && res.error) { toast(res.error); done('drop'); return; }
        done(true);
      });
    } catch {
      clearTimeout(bail);
      done(false);
    }
  });
}

/** Try again later, backing off as attempts pile up. */
function scheduleRetry() {
  if (retryTimer || !outbox.length) return;
  const tries = outbox[0].tries || 1;
  const wait = RETRY_BACKOFF_MS[Math.min(tries - 1, RETRY_BACKOFF_MS.length - 1)];
  retryTimer = setTimeout(() => { retryTimer = null; flushOutbox(); }, wait);
}

/**
 * Send everything, oldest first. Each send waits for its acknowledgement so
 * the server stores them in the order they were written rather than the order
 * they happen to land. Nothing leaves the queue unconfirmed.
 */
async function flushOutbox() {
  if (!online() || !outbox.length || flushing) return;
  clearTimeout(retryTimer); retryTimer = null;
  flushing = true;
  updateOfflineBar();

  while (outbox.length && online()) {
    const item = outbox[0];
    item.tries = (item.tries || 0) + 1;
    saveOutbox();
    if (item.failed) refreshQueued(item);

    const result = await sendQueued(item);

    if (result === false) {          // no answer — the connection died mid-send
      item.failed = true;
      saveOutbox();
      refreshQueued(item);
      break;
    }
    outbox.shift();
    // Something got through, so whatever failed before is no longer true.
    for (const i of outbox) i.failed = false;
    saveOutbox();
    // On success the real message arrives over message:new; on a permanent
    // rejection there is nothing to replace it with. Either way it goes.
    settleQueued(item.tempId);
  }

  flushing = false;
  updateOfflineBar();

  if (flushAgain) { flushAgain = false; return flushOutbox(); }
  if (outbox.length) scheduleRetry();
}

/** Throw away something that was never sent. */
function discardQueued(tempId) {
  const at = outbox.findIndex(i => i.tempId === tempId);
  if (at === -1) return;
  outbox.splice(at, 1);
  saveOutbox();
  settleQueued(tempId);
  updateOfflineBar();
}

/** Send it now, without waiting out the backoff. */
function retryOutboxNow() {
  clearTimeout(retryTimer); retryTimer = null;
  if (!outbox.length) return;
  if (!online()) { toast('Still no connection — it will send itself when there is one'); return; }
  // If a send is sitting there timing out, do not make the user wait it out:
  // abandon that attempt and start a fresh one straight away.
  if (flushing && inflight) { flushAgain = true; inflight(false); return; }
  flushOutbox();
}

/** The banner that tells you the app is holding your messages. */
function updateOfflineBar() {
  const bar = $('offline-bar');
  if (!bar) return;
  const waiting = outbox.length;
  const off = !online();
  const stuck = waiting > 0 && !!outbox[0].failed;
  // A single message on its way out is not news — saying nothing is the
  // correct report of a connection that is working.
  const backlog = flushing && waiting > 1;
  bar.classList.toggle('show', off || stuck || backlog);
  bar.classList.toggle('stuck', !off && stuck);

  let text = '';
  if (off) {
    text = waiting
      ? `Offline — ${waiting} message${waiting > 1 ? 's' : ''} waiting to send`
      : 'Offline — messages will send when you reconnect';
  } else if (stuck) {
    text = `Can't reach the server — ${waiting} message${waiting > 1 ? 's' : ''} waiting`;
  } else if (backlog) {
    text = `Sending ${waiting} queued messages…`;
  }
  bar.textContent = text;

  // Somewhere to press when waiting is not the answer.
  if (!off && stuck) {
    const again = el('button', 'bar-retry', 'Try now');
    again.onclick = () => retryOutboxNow();
    bar.appendChild(again);
  }
}

// ── Lite mode ──────────────────────────────────────────────────────────
/**
 * Data-saver. Built for the very common case where one person is nearly out
 * of bundle: photos arrive as a tap-to-load placeholder instead of
 * downloading themselves, outgoing photos are squeezed much harder, and
 * video calling is traded for voice — an hour of talking costs a few MB
 * instead of a few hundred.
 */
let lite = localStorage.getItem('vchat.lite') === '1';

// URLs the user tapped to load — they stay visible for the rest of the session.
const shownPhotos = new Set();

// Bytes we did not spend, counted so the saving is visible rather than claimed.
let liteSaved = Number(localStorage.getItem('vchat.liteSaved') || 0);

function liteOn() { return lite; }

function addSaved(bytes) {
  if (!(bytes > 0)) return;
  liteSaved += bytes;
  localStorage.setItem('vchat.liteSaved', String(liteSaved));
}

function setLite(on) {
  lite = !!on;
  localStorage.setItem('vchat.lite', lite ? '1' : '0');
  document.body.classList.toggle('lite', lite);
  updateCallButtons();
  if (activeId) renderMessages();
  if (document.body.classList.contains('reels-open')) renderReels(visibleReelId());
  toast(lite ? 'Lite mode on — media loads only when requested' : 'Lite mode off');
}

function openLiteMode() {
  const box = $('lite-toggle');
  box.checked = lite;
  box.onchange = () => {
    setLite(box.checked);
    $('lite-saved').textContent = liteSummary();
  };
  $('lite-saved').textContent = liteSummary();
  openModal('modal-lite');
}

function liteSummary() {
  return liteSaved > 0 ? `You have saved about ${fileSize(liteSaved)} so far.` : '';
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
const LITE_MAX_EDGE = 900;      // lite mode: still fine on a phone screen
const LITE_QUALITY = 0.6;       // lite mode: visibly softer, a fraction of the bytes

async function compressImage(file) {
  if (!file.type.startsWith('image/')) return file;
  // GIFs would lose animation; SVG is vector and tiny already.
  if (/gif|svg/.test(file.type)) return file;
  // Lite mode squeezes everything, even the small ones.
  if (file.size < IMG_SKIP_BELOW && !lite) return file;

  const maxEdge = lite ? LITE_MAX_EDGE : IMG_MAX_EDGE;
  const quality = lite ? LITE_QUALITY : IMG_QUALITY;

  try {
    const bitmap = await createImageBitmap(file);
    const { width: w, height: h } = bitmap;
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    // Already small enough and re-encoding probably won't help a modern JPEG.
    if (scale === 1 && file.size < 1024 * 1024 && !lite) { bitmap.close?.(); return file; }

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

    const blob = await new Promise(res => canvas.toBlob(res, outType, quality));
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
  fd.append('chatId', activeId || '');
  const saved = original - file.size;
  addSaved(saved);
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
  fd.append('chatId', activeId || '');
  try {
    const res = await fetch('/api/messenger/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const payload = {
      chatId: activeId,
      text: '',
      file: { ...data, voice: true, duration: secs },
      type: 'voice',
      replyTo,
    };
    queueMessage(payload);
    flushOutbox();
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
  const isGroupAdmin = c.type === 'group' && (c.admins || []).includes(me.id);
  const canEditGroupInfo = c.type === 'group' && (c.permissions?.editInfo !== 'admins' || isGroupAdmin);
  const canAddGroupMembers = c.type === 'group' && (c.permissions?.addMembers !== 'admins' || isGroupAdmin);
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

  if (c.type === 'group' && (c.about || canEditGroupInfo)) {
    const info = el('div', 'drawer-block left', `<div class="drawer-label">Group description</div><div class="drawer-value">${esc(c.about || 'Add a group description')}</div>`);
    if (canEditGroupInfo) {
      info.style.cursor = 'pointer';
      info.onclick = () => {
        const about = prompt('Group description', c.about || '');
        if (about != null) socket.emit('group:update', { chatId: c.id, about }, result => result?.error && toast(result.error));
      };
    }
    body.appendChild(info);
  }

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
        ${(c.admins || []).includes(u.id) ? '<span class="mr-tag">Admin</span>' : ''}`);
      if (u.id !== me.id) {
        row.onclick = () => socket.emit('chat:startDM', { targetUserId: u.id }, r => r?.chat && openChat(r.chat.id));
        if (isGroupAdmin) {
          row.oncontextmenu = event => {
            event.preventDefault();
            const admin = (c.admins || []).includes(u.id);
            showCtxMenu(event, [
              { label: admin ? 'Dismiss as admin' : 'Make group admin', fn: () => socket.emit('group:setAdmin', { chatId: c.id, memberId: u.id, makeAdmin: !admin }, result => result?.error && toast(result.error)) },
              { label: 'Remove from group', danger: true, fn: () => socket.emit('group:removeMember', { chatId: c.id, memberId: u.id }, result => result?.error && toast(result.error)) },
            ]);
          };
        }
      }
      members.appendChild(row);
    });
    if (canAddGroupMembers) {
      const add = el('button', 'drawer-action', `<span style="color:var(--wa-green)">${icon('group')}</span> Add participants`);
      add.onclick = () => openAddMembers(c);
      members.appendChild(add);
    }
    if (isGroupAdmin) {
      const settings = el('button', 'drawer-action', `<span style="color:var(--wa-green)">${icon('info')}</span> Group permissions`);
      settings.onclick = () => openGroupSettings(c);
      members.appendChild(settings);
      const invite = el('button', 'drawer-action', `<span style="color:var(--wa-green)">${icon('copy')}</span> Copy new invite link`);
      invite.onclick = () => socket.emit('chat:createInvite', { chatId: c.id }, result => {
        if (result?.error) return toast(result.error);
        const url = new URL(result.path, location.origin).href;
        navigator.clipboard?.writeText(url);
        toast('Invite link copied');
      });
      members.appendChild(invite);
    }
    body.appendChild(members);
  }

  const actions = el('div', '');
  const mute = el('button', 'drawer-action', `${icon('mute')} ${c.muted ? 'Unmute notifications' : 'Mute notifications'}`);
  mute.onclick = () => { socket.emit('chat:flag', { chatId: c.id, flag: 'muted', value: !c.muted }); setTimeout(openDrawer, 150); };
  const pin = el('button', 'drawer-action', `${icon('pin')} ${c.pinned ? 'Unpin chat' : 'Pin chat'}`);
  pin.onclick = () => { socket.emit('chat:flag', { chatId: c.id, flag: 'pinned', value: !c.pinned }); setTimeout(openDrawer, 150); };
  const clear = el('button', 'drawer-action danger', `${icon('trash')} Clear messages`);
  clear.onclick = () => { if (confirm('Clear all messages in this chat?')) socket.emit('chat:clear', { chatId: c.id }); };
  actions.append(mute, pin);
  if (c.type === 'dm' && entity?.id) {
    const isBlocked = (me.blocked || []).includes(entity.id);
    const block = el('button', 'drawer-action danger', `${icon('close')} ${isBlocked ? 'Unblock' : 'Block'} ${esc(entity.username || 'contact')}`);
    block.onclick = async () => {
      const { ok, data } = await api(`/api/account/block/${encodeURIComponent(entity.id)}`, { blocked: !isBlocked });
      if (!ok) return toast(data.error || 'Could not update block list');
      const set = new Set(me.blocked || []);
      if (isBlocked) set.delete(entity.id); else set.add(entity.id);
      me.blocked = [...set];
      toast(isBlocked ? 'Contact unblocked' : 'Contact blocked');
      if (document.body.classList.contains('reels-open')) loadReels(true, true).catch(() => {});
      if ($('stories-screen').classList.contains('open')) loadStories({ quiet: true }).catch(() => {});
      openDrawer();
    };
    const report = el('button', 'drawer-action danger', `${icon('info')} Report contact`);
    report.onclick = async () => {
      const reason = prompt('Why are you reporting this contact?', 'Spam');
      if (!reason) return;
      const { ok, data } = await api(`/api/account/report/${encodeURIComponent(entity.id)}`, { chatId: c.id, reason });
      toast(ok ? 'Report submitted' : (data.error || 'Could not submit report'));
    };
    actions.append(block, report);
  }
  actions.append(clear);
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
function closeModal(id) {
  $(id).classList.remove('show');
  if (id === 'modal-profile') profileModalCleanup?.();
  if (id === 'modal-reel-upload') reelUploadCleanup?.();
  if (id === 'modal-story-compose') cleanupStoryComposer();
  if (id === 'modal-rate') rating = null;
}
document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('click', e => {
    if (e.target === o) closeModal(o.id);
  });
  o.querySelectorAll('[data-close]').forEach(b => b.onclick = () => closeModal(o.id));
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

function openGroupSettings(c) {
  if (!c || !(c.admins || []).includes(me.id)) return;
  $('group-permission-info').value = c.permissions?.editInfo || 'admins';
  $('group-permission-send').value = c.permissions?.sendMessages || 'members';
  $('group-permission-add').value = c.permissions?.addMembers || 'admins';
  $('group-settings-save').onclick = () => {
    socket.emit('group:update', {
      chatId: c.id,
      permissions: {
        editInfo: $('group-permission-info').value,
        sendMessages: $('group-permission-send').value,
        addMembers: $('group-permission-add').value,
      },
    }, result => {
      if (result?.error) return toast(result.error);
      closeModal('modal-group-settings');
      toast('Group permissions updated');
    });
  };
  openModal('modal-group-settings');
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
    if (!picked.size) return closeModal('modal-addmembers');
    socket.emit('chat:addMembers', { chatId: c.id, members: [...picked] }, result => {
      if (result?.error) return toast(result.error);
      closeModal('modal-addmembers');
    });
  };
  openModal('modal-addmembers');
}

// ── Lightbox ───────────────────────────────────────────────────────────
function openLightbox(url, name) {
  $('lb-img').src = url;
  $('lb-name').textContent = name || '';
  $('lb-download').href = url;
  $('lb-download').download = name || 'image';
  $('lb-download').hidden = !!activeChat()?.advancedPrivacy;
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

// ── Privacy, account security and linked devices ─────────────────────
async function openPrivacy() {
  const privacy = me.privacy || {};
  $('privacy-last-seen').value = privacy.lastSeen || 'contacts';
  $('privacy-online').value = privacy.online || 'same-as-last-seen';
  $('privacy-photo').value = privacy.profilePhoto || 'everyone';
  $('privacy-about').value = privacy.about || 'everyone';
  $('privacy-timer').value = String(privacy.defaultDisappearingSeconds || 0);
  $('privacy-receipts').checked = privacy.readReceipts !== false;
  $('privacy-advanced').checked = !!privacy.advancedChatPrivacy;
  $('privacy-silence').checked = privacy.silenceUnknownCallers !== false;
  $('two-step-status').textContent = me.twoStepEnabled ? 'PIN is enabled' : 'Add a PIN for extra account protection';
  $('two-step-set').textContent = me.twoStepEnabled ? 'Change PIN' : 'Set PIN';
  $('two-step-disable').hidden = !me.twoStepEnabled;
  openModal('modal-privacy');
  await loadDevices();
}

async function loadDevices() {
  const list = $('device-list');
  list.innerHTML = '<div class="empty-list">Loading…</div>';
  const { ok, data } = await api('/api/account/devices');
  if (!ok || !Array.isArray(data)) {
    list.innerHTML = '<div class="empty-list">Could not load linked devices.</div>';
    return;
  }
  list.innerHTML = '';
  data.forEach(device => {
    const name = /Mobile|Android|iPhone/i.test(device.userAgent || '') ? 'Mobile browser' : 'Desktop browser';
    const row = el('div', 'device-row', `<div>${icon('newchat')}<span><strong>${esc(name)}${device.current ? ' · This device' : ''}</strong><small>Last active ${esc(new Date(device.lastUsedAt).toLocaleString())}</small></span></div>`);
    if (!device.current) {
      const remove = el('button', 'btn-text', 'Log out');
      remove.onclick = async () => {
        const result = await api(`/api/account/devices/${encodeURIComponent(device.id)}`, undefined, { method: 'DELETE' });
        if (!result.ok) return toast(result.data.error || 'Could not log out device');
        loadDevices();
      };
      row.appendChild(remove);
    }
    list.appendChild(row);
  });
}

$('privacy-save').onclick = async () => {
  const patch = {
    lastSeen: $('privacy-last-seen').value,
    online: $('privacy-online').value,
    profilePhoto: $('privacy-photo').value,
    about: $('privacy-about').value,
    defaultDisappearingSeconds: Number($('privacy-timer').value),
    readReceipts: $('privacy-receipts').checked,
    advancedChatPrivacy: $('privacy-advanced').checked,
    silenceUnknownCallers: $('privacy-silence').checked,
  };
  const { ok, data } = await api('/api/account/privacy', patch, { method: 'PATCH' });
  if (!ok) return toast(data.error || 'Could not save privacy settings');
  me.privacy = data.privacy;
  closeModal('modal-privacy');
  toast('Privacy settings saved');
};

$('two-step-set').onclick = async () => {
  const currentPin = me.twoStepEnabled ? prompt('Enter your current 6-digit PIN') : null;
  if (me.twoStepEnabled && currentPin == null) return;
  const pin = prompt(me.twoStepEnabled ? 'Choose a new 6-digit PIN' : 'Choose a 6-digit two-step verification PIN');
  if (pin == null) return;
  const { ok, data } = await api('/api/account/two-step', { pin, currentPin }, { method: 'PUT' });
  if (!ok) return toast(data.error || 'Could not set PIN');
  me.twoStepEnabled = true;
  $('two-step-status').textContent = 'PIN is enabled';
  $('two-step-set').textContent = 'Change PIN';
  $('two-step-disable').hidden = false;
  toast('Two-step verification enabled');
};

$('two-step-disable').onclick = async () => {
  const pin = prompt('Enter your current PIN to disable two-step verification');
  if (pin == null) return;
  const { ok, data } = await api('/api/account/two-step', { pin }, { method: 'DELETE' });
  if (!ok) return toast(data.error || 'Could not disable two-step verification');
  me.twoStepEnabled = false;
  $('two-step-status').textContent = 'Add a PIN for extra account protection';
  $('two-step-set').textContent = 'Set PIN';
  $('two-step-disable').hidden = true;
  toast('Two-step verification disabled');
};

$('devices-revoke-all').onclick = async () => {
  if (!confirm('Log out every other linked device?')) return;
  const { ok, data } = await api('/api/account/devices', undefined, { method: 'DELETE' });
  if (!ok) return toast(data.error || 'Could not log out devices');
  toast(`${data.revoked || 0} device${data.revoked === 1 ? '' : 's'} logged out`);
  loadDevices();
};

let installPrompt = null;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
});
async function installApp() {
  if (!installPrompt) return toast('Use your browser menu to install VChat');
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
}

// ── Notification, ringtone and media preferences (per linked device) ──
function notificationPermissionText() {
  if (!('Notification' in window)) return 'Desktop notifications are not supported by this browser';
  if (Notification.permission === 'granted') return 'Enabled while Vchat is open on this device';
  if (Notification.permission === 'denied') return 'Blocked in browser settings';
  return 'Allow browser alerts while Vchat is open';
}

function readNotificationDraft() {
  return {
    desktop: $('notify-desktop').checked,
    previews: $('notify-preview').checked,
    messageSounds: $('notify-sounds').checked,
    messageTone: $('notify-tone').value,
    callSounds: $('notify-call-sounds').checked,
    ringtone: $('notify-ringtone').value,
    mediaVisibility: $('media-visibility').value,
  };
}

function openNotifications() {
  $('notify-desktop').checked = notificationPrefs.desktop;
  $('notify-preview').checked = notificationPrefs.previews;
  $('notify-sounds').checked = notificationPrefs.messageSounds;
  $('notify-tone').value = notificationPrefs.messageTone;
  $('notify-call-sounds').checked = notificationPrefs.callSounds;
  $('notify-ringtone').value = notificationPrefs.ringtone;
  $('media-visibility').value = notificationPrefs.mediaVisibility;
  $('notification-permission-status').textContent = notificationPermissionText();
  $('notify-desktop').disabled = !('Notification' in window) || Notification.permission === 'denied';

  $('notify-desktop').onchange = async () => {
    if (!$('notify-desktop').checked || !('Notification' in window)) return;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') $('notify-desktop').checked = false;
    } catch {
      $('notify-desktop').checked = false;
    }
    $('notification-permission-status').textContent = notificationPermissionText();
  };
  $('notify-test').onclick = () => {
    const previous = notificationPrefs.messageTone;
    notificationPrefs.messageTone = $('notify-tone').value;
    ping(true);
    notificationPrefs.messageTone = previous;
  };
  $('ringtone-test').onclick = () => {
    if (ringTone) return callToneStop();
    const previous = notificationPrefs.ringtone;
    notificationPrefs.ringtone = $('notify-ringtone').value;
    callTone('ring', true);
    notificationPrefs.ringtone = previous;
    setTimeout(callToneStop, 4200);
  };
  $('notifications-save').onclick = () => {
    notificationPrefs = { ...NOTIFICATION_DEFAULTS, ...readNotificationDraft() };
    localStorage.setItem('vchat.notifications', JSON.stringify(notificationPrefs));
    callToneStop();
    if (activeId) renderMessages();
    closeModal('modal-notifications');
    toast('Notification and media settings saved');
  };
  openModal('modal-notifications');
}

// ── Reels companion pane ──────────────────────────────────────────────
function visibleReelId() {
  const feed = $('reels-feed');
  const cards = [...feed.querySelectorAll('.reel-card')];
  if (!cards.length) return null;
  return cards.reduce((best, card) => (
    Math.abs(card.offsetTop - feed.scrollTop) < Math.abs(best.offsetTop - feed.scrollTop) ? card : best
  )).dataset.id;
}

function pauseReelVideos() {
  $('reels-feed')?.querySelectorAll('video').forEach(video => video.pause());
}

function reelAutoplayEnabled() {
  return !lite && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

async function loadReels(reset = false, preservePosition = false) {
  if (reelsLoading) {
    if (reset) reelsReloadPending = true;
    return;
  }
  const keepId = preservePosition ? visibleReelId() : null;
  reelsLoading = true;
  if (reset) {
    reelsCursor = null;
    reelsExhausted = false;
  }
  if (!reels.length) $('reels-feed').innerHTML = '<div class="reels-loading">Loading reels…</div>';
  try {
    const query = new URLSearchParams({ limit: '10' });
    if (!reset && reelsCursor) query.set('cursor', reelsCursor);
    const response = await fetch(`/api/reels?${query}`, { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not load reels');
    const incoming = Array.isArray(data.items) ? data.items : [];
    if (Number.isFinite(data.maxUploadBytes) && data.maxUploadBytes > 0) reelMaxBytes = data.maxUploadBytes;
    if (reset) reels = incoming;
    else {
      const known = new Set(reels.map(reel => reel.id));
      reels.push(...incoming.filter(reel => !known.has(reel.id)));
    }
    reelsCursor = data.nextCursor || null;
    reelsExhausted = !reelsCursor;
    if (document.body.classList.contains('reels-open')) renderReels(keepId);
  } catch (error) {
    if (!reels.length) {
      $('reels-feed').innerHTML = `<div class="reels-empty"><strong>Reels unavailable</strong><span>${esc(error.message)}</span><button class="btn-text" type="button" id="reels-retry">Try again</button></div>`;
      $('reels-retry').onclick = () => loadReels(true);
    } else toast(error.message);
  } finally {
    reelsLoading = false;
    if (reelsReloadPending) {
      reelsReloadPending = false;
      if (document.body.classList.contains('reels-open')) loadReels(true, true);
    }
  }
}

function renderReels(keepId = null) {
  const feed = $('reels-feed');
  reelsObserver?.disconnect();
  reelsObserver = null;
  feed.innerHTML = '';

  if (!reels.length) {
    feed.innerHTML = '<div class="reels-empty"><strong>No reels yet</strong><span>Post a short video and keep chatting while everyone scrolls.</span><button class="btn-text" type="button" id="reels-empty-upload">Post the first reel</button></div>';
    $('reels-empty-upload').onclick = chooseReelFile;
    return;
  }

  for (const reel of reels) {
    const owner = reel.owner || { id: '', username: 'Vchat user', avatar: '🎬' };
    const mine = owner.id === me.id;
    const card = el('article', 'reel-card paused');
    card.dataset.id = reel.id;
    card.innerHTML = `
      <video class="reel-video" src="${esc(reel.videoUrl)}" muted loop playsinline preload="${lite ? 'none' : 'metadata'}" aria-label="Reel by ${esc(owner.username)}"></video>
      <div class="reel-play-state">${icon('play')}</div>
      <div class="reel-shade"></div>
      <div class="reel-meta">
        <button class="reel-owner" type="button" data-reel-action="chat" ${mine ? 'disabled' : ''}>${avatarHTML(owner, 32)}<span>${esc(mine ? 'You' : owner.username)}</span></button>
        ${reel.caption ? `<div class="reel-caption">${esc(reel.caption)}</div>` : ''}
        <span class="reel-date">${esc(dayLabel(reel.createdAt))} · ${esc(timeOf(reel.createdAt))}</span>
      </div>
      <div class="reel-actions">
        <button class="reel-action ${reel.liked ? 'on' : ''}" type="button" data-reel-action="like" aria-label="${reel.liked ? 'Unlike' : 'Like'} reel"><span aria-hidden="true">♥</span><span class="reel-action-count">${Number(reel.likeCount) || 0}</span></button>
        <button class="reel-action" type="button" data-reel-action="play" aria-label="Play reel">${icon('play')}</button>
        ${mine
          ? `<button class="reel-action" type="button" data-reel-action="delete" aria-label="Delete reel">${icon('trash')}</button>`
          : `<button class="reel-action" type="button" data-reel-action="chat" aria-label="Chat with ${esc(owner.username)}">${icon('chat')}</button>`}
        <button class="reel-action" type="button" data-reel-action="sound" aria-label="Turn sound on"><span aria-hidden="true">🔇</span></button>
      </div>`;

    const video = card.querySelector('video');
    const playButton = card.querySelector('[data-reel-action="play"]');
    const setPlaying = playing => {
      card.classList.toggle('paused', !playing);
      playButton.innerHTML = icon(playing ? 'pause' : 'play');
      playButton.setAttribute('aria-label', playing ? 'Pause reel' : 'Play reel');
    };
    video.onclick = () => video.paused ? video.play().catch(() => {}) : video.pause();
    video.onplay = () => setPlaying(true);
    video.onpause = () => setPlaying(false);
    video.onerror = () => card.classList.add('reel-error');
    playButton.onclick = event => {
      event.stopPropagation();
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    };

    card.querySelectorAll('[data-reel-action="chat"]').forEach(button => {
      if (!mine) button.onclick = event => { event.stopPropagation(); chatWithReelOwner(owner.id); };
    });
    card.querySelector('[data-reel-action="like"]').onclick = event => {
      event.stopPropagation();
      updateReelLike(reel, card);
    };
    card.querySelector('[data-reel-action="sound"]').onclick = event => {
      event.stopPropagation();
      video.muted = !video.muted;
      event.currentTarget.firstElementChild.textContent = video.muted ? '🔇' : '🔊';
      event.currentTarget.setAttribute('aria-label', video.muted ? 'Turn sound on' : 'Mute reel');
      if (video.paused) video.play().catch(() => {});
    };
    if (mine) card.querySelector('[data-reel-action="delete"]').onclick = event => {
      event.stopPropagation();
      removeReel(reel.id);
    };
    feed.appendChild(card);
  }

  reelsObserver = new IntersectionObserver(entries => {
    if (!document.body.classList.contains('reels-open')) return;
    for (const entry of entries) {
      const video = entry.target.querySelector('video');
      if (entry.isIntersecting && entry.intersectionRatio >= 0.65) {
        feed.querySelectorAll('video').forEach(other => { if (other !== video) other.pause(); });
        if (reelAutoplayEnabled()) video.play().catch(() => entry.target.classList.add('paused'));
      } else if (entry.intersectionRatio < 0.35) video.pause();
    }
  }, { root: feed, threshold: [0.2, 0.35, 0.65, 0.85] });
  feed.querySelectorAll('.reel-card').forEach(card => reelsObserver.observe(card));

  requestAnimationFrame(() => {
    const target = keepId && feed.querySelector(`[data-id="${CSS.escape(keepId)}"]`);
    if (target) feed.scrollTop = target.offsetTop;
  });
}

async function updateReelLike(reel, card) {
  const button = card.querySelector('[data-reel-action="like"]');
  if (button.disabled) return;
  button.disabled = true;
  const desired = !reel.liked;
  reel.liked = desired;
  reel.likeCount = Math.max(0, (Number(reel.likeCount) || 0) + (desired ? 1 : -1));
  button.classList.toggle('on', desired);
  button.setAttribute('aria-label', desired ? 'Unlike reel' : 'Like reel');
  button.querySelector('.reel-action-count').textContent = reel.likeCount;
  try {
    const { ok, data } = await api(`/api/reels/${encodeURIComponent(reel.id)}/like`, { liked: desired }, { method: 'PUT' });
    if (!ok) throw new Error(data.error || 'Could not update like');
    Object.assign(reel, data.reel);
    button.querySelector('.reel-action-count').textContent = reel.likeCount;
  } catch (error) {
    reel.liked = !desired;
    reel.likeCount = Math.max(0, reel.likeCount + (desired ? -1 : 1));
    button.classList.toggle('on', reel.liked);
    button.querySelector('.reel-action-count').textContent = reel.likeCount;
    toast(error.message || 'Could not update like');
  } finally {
    button.disabled = false;
  }
}

function chatWithReelOwner(ownerId) {
  if (!ownerId || ownerId === me.id) return;
  socket.emit('chat:startDM', { targetUserId: ownerId }, result => {
    if (result?.error) return toast(result.error);
    if (result?.chat) openChat(result.chat.id);
  });
}

async function removeReel(reelId) {
  if (!confirm('Delete this reel permanently?')) return;
  try {
    const { ok, data } = await api(`/api/reels/${encodeURIComponent(reelId)}`, {}, { method: 'DELETE' });
    if (!ok) throw new Error(data.error || 'Could not delete reel');
    const keep = visibleReelId();
    reels = reels.filter(reel => reel.id !== reelId);
    renderReels(keep === reelId ? null : keep);
    toast('Reel deleted');
  } catch (error) {
    toast(error.message || 'Could not delete reel');
  }
}

function openReels() {
  document.body.classList.add('reels-open');
  $('reels-panel').setAttribute('aria-hidden', 'false');
  $('btn-reels').setAttribute('aria-expanded', 'true');
  $('btn-reels-chat').setAttribute('aria-expanded', 'true');
  $('drawer').classList.remove('open');
  loadReels(true);
}

function closeReels() {
  clearTimeout(reelsRefreshTimer);
  reelsReloadPending = false;
  document.body.classList.remove('reels-open');
  $('reels-panel').setAttribute('aria-hidden', 'true');
  $('btn-reels').setAttribute('aria-expanded', 'false');
  $('btn-reels-chat').setAttribute('aria-expanded', 'false');
  pauseReelVideos();
}

function toggleReels() {
  if (document.body.classList.contains('reels-open')) closeReels();
  else openReels();
}

function chooseReelFile() {
  $('reel-file-input').value = '';
  $('reel-file-input').click();
}

function prepareReelUpload(file) {
  if (!file) return;
  if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(file.type) || file.size > reelMaxBytes) {
    return toast(`Choose an MP4, MOV, or WebM video up to ${fileSize(reelMaxBytes)}`);
  }
  reelUploadCleanup?.();
  reelUploadFile = file;
  reelUploadPreviewUrl = URL.createObjectURL(file);
  $('reel-upload-preview').src = reelUploadPreviewUrl;
  $('reel-file-summary').textContent = `${file.name} · ${fileSize(file.size)}`;
  $('reel-caption').value = '';
  $('reel-upload-status').textContent = '';
  $('reel-publish').disabled = false;
  const cleanup = () => {
    reelUploadAbort?.abort();
    reelUploadAbort = null;
    $('reel-upload-preview').pause();
    $('reel-upload-preview').removeAttribute('src');
    $('reel-upload-preview').load();
    if (reelUploadPreviewUrl) URL.revokeObjectURL(reelUploadPreviewUrl);
    reelUploadPreviewUrl = null;
    reelUploadFile = null;
    $('reel-file-input').value = '';
    if (reelUploadCleanup === cleanup) reelUploadCleanup = null;
  };
  reelUploadCleanup = cleanup;
  openModal('modal-reel-upload');
}

async function publishReel() {
  if (!reelUploadFile || reelUploadAbort) return;
  const button = $('reel-publish');
  const status = $('reel-upload-status');
  const form = new FormData();
  form.append('video', reelUploadFile, reelUploadFile.name);
  form.append('caption', $('reel-caption').value.trim());
  const request = new XMLHttpRequest();
  reelUploadAbort = request;
  button.disabled = true;
  status.textContent = 'Uploading securely… 0%';
  status.style.color = 'var(--text-secondary)';
  try {
    const data = await new Promise((resolve, reject) => {
      request.open('POST', '/api/reels');
      request.withCredentials = true;
      request.responseType = 'json';
      request.upload.onprogress = event => {
        if (event.lengthComputable) status.textContent = `Uploading securely… ${Math.min(99, Math.round((event.loaded / event.total) * 100))}%`;
      };
      request.onerror = () => reject(new Error('Network error while uploading'));
      request.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));
      request.onload = () => {
        const body = request.response && typeof request.response === 'object' ? request.response : {};
        if (request.status >= 200 && request.status < 300) resolve(body);
        else reject(new Error(body.error || 'Could not post reel'));
      };
      request.send(form);
    });
    if (!data.reel) throw new Error('The server did not return the published reel');
    reelUploadAbort = null;
    closeModal('modal-reel-upload');
    openReels();
    toast('Reel posted');
  } catch (error) {
    if (error.name === 'AbortError') return;
    reelUploadAbort = null;
    button.disabled = false;
    status.style.color = 'var(--danger)';
    status.textContent = error.message || 'Could not post reel';
  }
}

// ── Status stories and sponsored playback ─────────────────────────────
function storyBackgroundClass(background) {
  return `story-bg-${['jade', 'ocean', 'sunset', 'violet', 'charcoal'].includes(background) ? background : 'jade'}`;
}

function setStoriesOpen(open) {
  $('stories-screen').classList.toggle('open', open);
  $('stories-screen').setAttribute('aria-hidden', String(!open));
  if (!open) {
    closeStoryViewer();
    clearTimeout(storiesRefreshTimer);
  }
}

async function openStories() {
  closeReels();
  setStoriesOpen(true);
  $('story-notice').hidden = true;
  await loadStories();
}

function closeStories() {
  setStoriesOpen(false);
}

async function loadStories({ quiet = false } = {}) {
  if (storiesLoading || !me) return;
  storiesLoading = true;
  if (!quiet) $('stories-loading').hidden = false;
  try {
    const { ok, data } = await api('/api/stories');
    if (!ok) throw new Error(data.error || 'Could not load status updates');
    storyGroups = Array.isArray(data.groups) ? data.groups : [];
    storyAds = Array.isArray(data.ads) ? data.ads : [];
    storyReactions = Array.isArray(data.reactions) ? data.reactions : storyReactions;
    storyMaxBytes = Number(data.maxUploadBytes) || storyMaxBytes;
    storyPaymentConfigured = data.paymentConfigured === true;
    storyAdAdmin = data.adAdmin === true;
    $('story-review-button').hidden = !storyAdAdmin;
    renderStoryTray();
  } catch (error) {
    if (!quiet) toast(error.message || 'Could not load status updates');
  } finally {
    storiesLoading = false;
    $('stories-loading').hidden = true;
  }
}

function renderStoryTray() {
  const tray = $('story-tray');
  tray.innerHTML = '';
  const own = storyGroups.find(group => group.mine);
  if (!own) {
    const add = el('button', 'story-tray-card add-card');
    add.type = 'button';
    add.innerHTML = `${avatarHTML(me, 40)}<span class="story-tray-name">Your status</span><span class="story-tray-meta">Tap to add an update</span>`;
    add.onclick = openStoryComposer;
    tray.appendChild(add);
  }
  for (const group of storyGroups) {
    const card = el('button', `story-tray-card${group.unseenCount ? ' unseen' : ''}`);
    card.type = 'button';
    card.setAttribute('role', 'listitem');
    const latest = group.items[group.items.length - 1];
    card.innerHTML = `${avatarHTML(group.owner, 40)}<span class="story-tray-name">${esc(group.mine ? 'Your status' : group.owner?.username)}</span><span class="story-tray-meta">${group.unseenCount ? `${group.unseenCount} new · ` : ''}${esc(rowTime(latest?.createdAt || Date.now()))}</span>`;
    card.onclick = () => openStoryViewer(group.owner?.id);
    tray.appendChild(card);
  }
  const friendCount = storyGroups.filter(group => !group.mine).length;
  $('stories-empty').hidden = friendCount > 0 || Boolean(own);
}

function buildStorySequence(ownerId) {
  const selectedIndex = storyGroups.findIndex(group => group.owner?.id === ownerId);
  if (selectedIndex < 0) return [];
  const selected = storyGroups[selectedIndex];
  const groups = selected.mine
    ? [selected]
    : storyGroups.slice(selectedIndex).filter(group => !group.mine);
  const organic = groups.flatMap(group => group.items.map(item => ({ ...item, kind: 'story' })));
  if (selected.mine || !organic.length || !storyAds.length) return organic;
  const firstAdAfter = organic.length > 3 ? 3 : Math.max(1, organic.length - 1);
  const sequence = [];
  let sinceAd = 0;
  let adIndex = 0;
  for (const item of organic) {
    sequence.push(item);
    sinceAd += 1;
    const threshold = adIndex === 0 ? firstAdAfter : 3;
    if (sinceAd >= threshold && adIndex < storyAds.length) {
      sequence.push({ ...storyAds[adIndex], kind: 'ad' });
      adIndex += 1;
      sinceAd = 0;
    }
  }
  return sequence;
}

function openStoryViewer(ownerId) {
  storySequence = buildStorySequence(ownerId);
  if (!storySequence.length) return;
  $('stories-home').hidden = true;
  $('story-viewer').hidden = false;
  storyIndex = 0;
  renderCurrentStory();
}

function closeStoryViewer() {
  stopStoryPlayback();
  $('story-stage').querySelectorAll('video').forEach(video => video.pause());
  $('story-viewer').hidden = true;
  $('stories-home').hidden = false;
  storySequence = [];
  storyIndex = -1;
  if ($('stories-screen').classList.contains('open')) loadStories({ quiet: true }).catch(() => {});
}

function renderStoryProgress() {
  $('story-progress').innerHTML = storySequence.map((_item, index) => `<span class="story-progress-part${index < storyIndex ? ' done' : ''}"><span class="story-progress-fill"></span></span>`).join('');
}

function stopStoryPlayback() {
  if (storyPlayback?.raf) cancelAnimationFrame(storyPlayback.raf);
  storyPlayback = null;
}

function startStoryPlayback(duration) {
  stopStoryPlayback();
  const index = storyIndex;
  const state = { duration: Math.max(1000, duration), elapsed: 0, last: performance.now(), raf: 0 };
  storyPlayback = state;
  const fill = $('story-progress').children[index]?.firstElementChild;
  const tick = now => {
    if (storyPlayback !== state || index !== storyIndex) return;
    const delta = Math.min(250, now - state.last);
    state.last = now;
    if (!document.hidden) state.elapsed += delta;
    if (fill) fill.style.width = `${Math.min(100, (state.elapsed / state.duration) * 100)}%`;
    if (storySequence[index]?.kind === 'ad') $('story-ad-countdown').textContent = `${Math.max(0, Math.ceil((state.duration - state.elapsed) / 1000))}s`;
    if (state.elapsed >= state.duration) return showNextStory(true);
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

function renderCurrentStory() {
  stopStoryPlayback();
  if (storyIndex < 0 || storyIndex >= storySequence.length) return closeStoryViewer();
  const item = storySequence[storyIndex];
  const isAd = item.kind === 'ad';
  const owner = isAd ? item.advertiser : item.owner;
  renderStoryProgress();
  $('story-viewer-avatar').innerHTML = avatarHTML(owner || { id: 'vchat', username: 'Vchat', avatar: '💬' }, 40);
  $('story-viewer-name').textContent = owner?.username || 'Vchat';
  $('story-viewer-time').textContent = isAd ? 'Promoted story' : rowTime(item.createdAt);
  $('story-sponsored').hidden = !isAd;
  $('story-ad-countdown').hidden = !isAd;
  $('story-delete').hidden = isAd || !item.mine;
  $('story-insight').hidden = isAd || !item.mine;
  $('story-insight').textContent = item.mine ? `${Number(item.viewCount) || 0} view${Number(item.viewCount) === 1 ? '' : 's'} · ${Number(item.reactionCount) || 0} reactions` : '';
  $('story-reactions').hidden = isAd || item.mine;
  $('story-reactions').innerHTML = isAd || item.mine ? '' : storyReactions.map(reaction => `<button class="story-reaction${item.myReaction === reaction ? ' selected' : ''}" type="button" data-reaction="${reaction}" aria-label="React ${reaction}">${reaction}</button>`).join('');
  $('story-reactions').querySelectorAll('.story-reaction').forEach(button => {
    button.onclick = () => reactToStory(item, button.dataset.reaction);
  });

  const cta = $('story-ad-cta');
  const destination = isAd && /^https?:\/\//i.test(item.destinationUrl || '') ? item.destinationUrl : null;
  const internalAction = isAd && ['profile_visits', 'messages'].includes(item.objective)
    && item.advertiser?.id && item.advertiser.id !== me.id;
  cta.hidden = !destination && !internalAction;
  cta.textContent = item.cta || (item.objective === 'messages' ? 'Send message' : 'Learn more');
  cta.href = destination || '#';
  cta.target = destination ? '_blank' : '';
  cta.onclick = destination ? () => {
    api(`/api/story-ads/${encodeURIComponent(item.id)}/click`, {}).catch(() => {});
  } : (internalAction ? event => {
    event.preventDefault();
    api(`/api/story-ads/${encodeURIComponent(item.id)}/click`, {}).catch(() => {});
    closeStories();
    socket.emit('chat:startDM', { targetUserId: item.advertiser.id }, result => {
      if (result?.error) return toast(result.error);
      if (!result?.chat) return;
      openChat(result.chat.id);
      if (item.objective === 'profile_visits') setTimeout(openDrawer, 0);
    });
  } : null);

  const stage = $('story-stage');
  stage.innerHTML = '';
  if (item.type === 'image' && item.mediaUrl) {
    const image = el('img', 'story-stage-media');
    image.alt = item.text || `${owner?.username || 'Contact'} status`;
    image.src = item.mediaUrl;
    stage.appendChild(image);
    if (item.text) stage.appendChild(el('div', 'story-stage-caption', esc(item.text)));
    startStoryPlayback(isAd ? 30000 : 6500);
  } else if (item.type === 'video' && item.mediaUrl) {
    const video = el('video', 'story-stage-media');
    video.src = item.mediaUrl;
    video.playsInline = true;
    video.preload = lite ? 'none' : 'metadata';
    video.loop = isAd;
    video.onloadedmetadata = () => {
      const normalDuration = Number.isFinite(video.duration) ? Math.min(60000, Math.max(3000, video.duration * 1000)) : 10000;
      if (!isAd) startStoryPlayback(normalDuration);
      video.play().catch(() => { video.controls = true; });
    };
    video.onerror = () => toast('This status video is unavailable');
    stage.appendChild(video);
    if (item.text) stage.appendChild(el('div', 'story-stage-caption', esc(item.text)));
    startStoryPlayback(isAd ? 30000 : 10000);
  } else {
    const headline = isAd && item.headline ? `<div>${esc(item.headline)}</div>` : '';
    const detail = item.text ? `<small>${esc(item.text)}</small>` : '';
    const text = el('div', `story-stage-text ${storyBackgroundClass(item.background)}`, `${headline || (!isAd ? esc(item.text) : '')}${isAd ? detail : ''}`);
    stage.appendChild(text);
    startStoryPlayback(isAd ? 30000 : 6500);
  }

  if (isAd) {
    api(`/api/story-ads/${encodeURIComponent(item.id)}/impression`, {}).catch(() => {});
  } else if (!item.mine) {
    api(`/api/stories/${encodeURIComponent(item.id)}/view`, {}).then(({ ok, data }) => {
      if (ok && storySequence[storyIndex]?.id === item.id) Object.assign(item, data.story || {}, { seen: true });
    }).catch(() => {});
  }
}

function showNextStory(adFinished = false) {
  if (storySequence[storyIndex]?.kind === 'ad' && !adFinished) {
    toast(`Sponsored story · ${$('story-ad-countdown').textContent || '30s'} remaining`);
    return;
  }
  if (storyIndex >= storySequence.length - 1) {
    closeStoryViewer();
    loadStories({ quiet: true });
    return;
  }
  storyIndex += 1;
  renderCurrentStory();
}

function showPreviousStory() {
  if (storyIndex <= 0) return;
  storyIndex -= 1;
  renderCurrentStory();
}

async function reactToStory(item, reaction) {
  const desired = item.myReaction === reaction ? null : reaction;
  const { ok, data } = await api(`/api/stories/${encodeURIComponent(item.id)}/reaction`, { reaction: desired }, { method: 'PUT' });
  if (!ok) return toast(data.error || 'Could not send reaction');
  Object.assign(item, data.story || {});
  renderCurrentStory();
  toast(desired ? `Reacted ${desired}` : 'Reaction removed');
}

async function deleteCurrentStory() {
  const item = storySequence[storyIndex];
  if (!item?.mine || !confirm('Delete this status?')) return;
  const { ok, data } = await api(`/api/stories/${encodeURIComponent(item.id)}`, {}, { method: 'DELETE' });
  if (!ok) return toast(data.error || 'Could not delete status');
  toast('Status deleted');
  closeStoryViewer();
  loadStories();
}

function cleanupStoryComposer() {
  storyUploadRequest?.abort();
  storyUploadRequest = null;
  storyPublishing = false;
  if (storyPreviewUrl) URL.revokeObjectURL(storyPreviewUrl);
  storyPreviewUrl = null;
  storyFile = null;
  $('story-file-input').value = '';
}

function updateStoryComposePreview() {
  const preview = $('story-compose-preview');
  preview.className = `story-compose-preview ${storyBackgroundClass(storyBackground)}`;
  preview.innerHTML = '';
  if (storyFile) {
    const media = document.createElement(storyFile.type.startsWith('video/') ? 'video' : 'img');
    media.src = storyPreviewUrl;
    if (media.tagName === 'VIDEO') { media.muted = true; media.loop = true; media.autoplay = true; media.playsInline = true; }
    media.alt = '';
    preview.appendChild(media);
  } else {
    const text = $('story-text').value.trim();
    preview.textContent = text || 'Write a status or choose a photo or video';
  }
}

function openStoryComposer() {
  cleanupStoryComposer();
  storyBackground = 'jade';
  $('story-text').value = '';
  $('story-file-name').textContent = '';
  $('story-media-remove').hidden = true;
  $('story-boost-toggle').checked = false;
  $('story-boost-fields').hidden = true;
  $('boost-objective').value = 'profile_visits';
  $('boost-url-row').hidden = true;
  $('boost-url').value = '';
  $('boost-budget').value = '30';
  $('boost-days').value = '7';
  $('boost-email').value = '';
  $('story-publish-status').textContent = '';
  $('story-publish').disabled = false;
  document.querySelectorAll('[data-story-color]').forEach(button => button.classList.toggle('selected', button.dataset.storyColor === 'jade'));
  updateStoryBoostDisclosure();
  updateBoostEstimate();
  updateStoryComposePreview();
  openModal('modal-story-compose');
}

function chooseStoryMedia(file) {
  if (!file) return;
  const supported = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'];
  if (!supported.includes(file.type) || file.size > storyMaxBytes) return toast(`Choose a supported photo or video up to ${fileSize(storyMaxBytes)}`);
  if (storyPreviewUrl) URL.revokeObjectURL(storyPreviewUrl);
  storyFile = file;
  storyPreviewUrl = URL.createObjectURL(file);
  $('story-file-name').textContent = `${file.name} · ${fileSize(file.size)}`;
  $('story-media-remove').hidden = false;
  updateStoryComposePreview();
}

function removeStoryMedia() {
  if (storyPreviewUrl) URL.revokeObjectURL(storyPreviewUrl);
  storyPreviewUrl = null;
  storyFile = null;
  $('story-file-input').value = '';
  $('story-file-name').textContent = '';
  $('story-media-remove').hidden = true;
  updateStoryComposePreview();
}

function updateStoryBoostDisclosure() {
  $('story-boost-disclosure').textContent = storyPaymentConfigured
    ? 'Boosts require ad review and confirmed payment before delivery. Posting your normal status does not depend on approval.'
    : 'Billing is not configured. Your status can still post, but this boost will not deliver unless an authorized administrator intentionally grants account credit.';
}

function updateBoostEstimate() {
  const budget = Math.max(0, Number($('boost-budget').value) || 0);
  const days = Math.max(1, Number($('boost-days').value) || 1);
  $('boost-estimate').textContent = `Pilot reservation: GHS ${budget.toLocaleString()} for up to ${days} day${days === 1 ? '' : 's'} after activation. No delivery forecast or result is guaranteed.`;
}

async function publishStory() {
  if (storyPublishing) return;
  const text = $('story-text').value.trim();
  const boosted = $('story-boost-toggle').checked;
  const status = $('story-publish-status');
  if (!storyFile && !text) { status.textContent = 'Write something or choose a photo or video.'; return; }
  if (boosted) {
    if (!/^\S+@\S+\.\S+$/.test($('boost-email').value.trim())) { status.textContent = 'Enter a billing email for your boost.'; return; }
    if ($('boost-objective').value === 'website_visits' && !/^https?:\/\//i.test($('boost-url').value.trim())) { status.textContent = 'Enter a complete http or https website address.'; return; }
    const budget = Number($('boost-budget').value);
    if (!Number.isFinite(budget) || budget < 10 || budget > 10000) { status.textContent = 'Choose a budget from GHS 10 to GHS 10,000.'; return; }
  }
  const form = new FormData();
  form.append('type', storyFile ? (storyFile.type.startsWith('video/') ? 'video' : 'image') : 'text');
  form.append('text', text);
  form.append('background', storyBackground);
  if (storyFile) form.append('media', storyFile, storyFile.name);
  form.append('boost', String(boosted));
  if (boosted) {
    form.append('objective', $('boost-objective').value);
    form.append('cta', $('boost-cta').value);
    form.append('destinationUrl', $('boost-url').value.trim());
    form.append('adAudience', $('boost-audience').value);
    form.append('budgetGhs', $('boost-budget').value);
    form.append('durationDays', $('boost-days').value);
    form.append('billingEmail', $('boost-email').value.trim());
  }
  const request = new XMLHttpRequest();
  storyUploadRequest = request;
  storyPublishing = true;
  $('story-publish').disabled = true;
  status.style.color = 'var(--text-secondary)';
  status.textContent = 'Publishing securely… 0%';
  try {
    const data = await new Promise((resolve, reject) => {
      request.open('POST', '/api/stories');
      request.withCredentials = true;
      request.responseType = 'json';
      request.upload.onprogress = event => {
        if (event.lengthComputable) status.textContent = `Publishing securely… ${Math.min(99, Math.round((event.loaded / event.total) * 100))}%`;
      };
      request.onerror = () => reject(new Error('Network error while publishing'));
      request.onabort = () => reject(Object.assign(new Error('Publishing cancelled'), { name: 'AbortError' }));
      request.onload = () => {
        const body = request.response && typeof request.response === 'object' ? request.response : {};
        if (request.status >= 200 && request.status < 300) resolve(body);
        else reject(new Error(body.error || 'Could not publish status'));
      };
      request.send(form);
    });
    storyUploadRequest = null;
    storyPublishing = false;
    closeModal('modal-story-compose');
    await loadStories();
    if (data.boostError) toast(data.boostError);
    else toast(data.campaign ? 'Status posted · boost saved for review and payment' : 'Status posted');
    if (data.payment?.authorizationUrl && confirm('Your status is live. Continue to Paystack to pay for this boost?')) {
      location.assign(data.payment.authorizationUrl);
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    storyUploadRequest = null;
    storyPublishing = false;
    $('story-publish').disabled = false;
    status.style.color = 'var(--danger)';
    status.textContent = error.message || 'Could not publish status';
  }
}

function campaignStatusLabel(status) {
  return String(status || 'pending').replaceAll('_', ' ');
}

function campaignCard(campaign, admin = false) {
  const card = el('article', 'campaign-card');
  const advertiser = admin ? `<p>Advertiser: <strong>${esc(campaign.advertiser?.username || 'Unknown')}</strong></p>` : '';
  const payment = campaign.paymentStatus ? `<p>Payment: ${esc(campaignStatusLabel(campaign.paymentStatus))} · Review: ${esc(campaignStatusLabel(campaign.reviewStatus))}</p>` : '';
  card.innerHTML = `<div class="campaign-card-head"><div><h3>${esc(campaign.text || 'Media status promotion')}</h3>${advertiser}<p>${esc(campaign.objective?.replaceAll('_', ' ') || 'Sponsored status')} · GHS ${Number(campaign.budgetGhs || 0).toFixed(2)} · ${Number(campaign.durationDays) || 0} day${Number(campaign.durationDays) === 1 ? '' : 's'}</p>${payment}</div><span class="campaign-state ${esc(campaign.status)}">${esc(campaignStatusLabel(campaign.status))}</span></div><div class="campaign-metrics"><div class="campaign-metric"><strong>${Number(campaign.reachCount) || 0}</strong><span>Reach</span></div><div class="campaign-metric"><strong>${Number(campaign.impressionCount) || 0}</strong><span>Impressions</span></div><div class="campaign-metric"><strong>${Number(campaign.clickCount) || 0}</strong><span>Clicks</span></div></div>`;
  const actions = el('div', 'campaign-actions');
  if (!admin && campaign.status === 'active') {
    const pause = el('button', '', 'Pause delivery');
    pause.type = 'button';
    pause.onclick = () => controlStoryCampaign(campaign.id, 'pause');
    actions.appendChild(pause);
  }
  if (!admin && campaign.status === 'paused') {
    const resume = el('button', '', 'Resume delivery');
    resume.type = 'button';
    resume.onclick = () => controlStoryCampaign(campaign.id, 'resume');
    actions.appendChild(resume);
  }
  if (!admin && !['completed', 'expired', 'rejected', 'stopped'].includes(campaign.status)) {
    const stop = el('button', '', 'Stop campaign');
    stop.type = 'button';
    stop.onclick = () => controlStoryCampaign(campaign.id, 'stop');
    actions.appendChild(stop);
  }
  if (!admin && campaign.checkoutUrl && !['paid', 'waived'].includes(campaign.paymentStatus)) {
    const pay = el('a', '', 'Continue secure payment');
    pay.href = campaign.checkoutUrl;
    pay.rel = 'noopener noreferrer';
    actions.appendChild(pay);
  }
  if (campaign.reviewNote) actions.appendChild(el('span', '', `Review note: ${esc(campaign.reviewNote)}`));
  if (campaign.reviewer) {
    const reviewedWhen = campaign.reviewedAt ? ` · ${esc(new Date(campaign.reviewedAt).toLocaleString())}` : '';
    actions.appendChild(el('span', '', `Reviewed by ${esc(campaign.reviewer.username || 'administrator')}${reviewedWhen}`));
  }
  if (campaign.stopNote || campaign.stopActor) {
    const stoppedWhen = campaign.stoppedAt ? ` · ${esc(new Date(campaign.stoppedAt).toLocaleString())}` : '';
    const stoppedBy = campaign.stopActor?.username ? ` by ${esc(campaign.stopActor.username)}` : '';
    actions.appendChild(el('span', '', `Stopped${stoppedBy}${stoppedWhen}${campaign.stopNote ? ` · ${esc(campaign.stopNote)}` : ''}`));
  }
  if (admin && ['active', 'paused'].includes(campaign.status)) {
    const stop = el('button', '', 'Stop delivery');
    stop.type = 'button';
    stop.onclick = () => controlStoryCampaign(campaign.id, 'stop', true);
    actions.appendChild(stop);
  }
  if (admin && campaign.reviewStatus === 'pending' && campaign.status !== 'stopped') {
    const approve = el('button', '', 'Approve');
    approve.onclick = () => reviewCampaign(campaign.id, 'approve', false);
    const reject = el('button', '', 'Reject');
    reject.onclick = () => reviewCampaign(campaign.id, 'reject', false);
    actions.appendChild(approve);
    if (campaign.paymentStatus !== 'paid') {
      const credit = el('button', '', 'Approve with account credit');
      credit.onclick = () => reviewCampaign(campaign.id, 'approve', true);
      actions.appendChild(credit);
    }
    actions.appendChild(reject);
  }
  if (actions.childNodes.length) card.appendChild(actions);
  return card;
}

async function controlStoryCampaign(campaignId, action, asAdmin = false) {
  let note = '';
  if (asAdmin) {
    note = prompt('Safety reason shown to the advertiser:', 'Advertising policy or safety action');
    if (note == null || !note.trim()) return;
  } else {
    const warning = action === 'stop'
      ? 'Stop this campaign permanently? This does not automatically issue a payment refund.'
      : `${action === 'pause' ? 'Pause' : 'Resume'} this campaign?`;
    if (!confirm(warning)) return;
  }
  const { ok, data } = await api(
    `/api/story-ads/${encodeURIComponent(campaignId)}/control`,
    { action, note },
    { method: 'PUT' },
  );
  if (!ok) return toast(data.error || 'Could not update campaign delivery');
  toast(`Campaign ${campaignStatusLabel(data.campaign.status)}`);
  if (asAdmin) await openStoryReview();
  else await openStoryBoosts();
}

async function openStoryBoosts() {
  openModal('modal-story-boosts');
  $('story-campaign-list').innerHTML = '<div class="empty-list">Loading boosts…</div>';
  const { ok, data } = await api('/api/story-ads/campaigns');
  if (!ok) { $('story-campaign-list').innerHTML = `<div class="empty-list">${esc(data.error || 'Could not load boosts')}</div>`; return; }
  const list = $('story-campaign-list');
  list.innerHTML = '';
  if (!data.campaigns?.length) list.innerHTML = '<div class="empty-list">No boosted status posts yet.</div>';
  else data.campaigns.forEach(campaign => list.appendChild(campaignCard(campaign)));
}

async function openStoryReview() {
  if (!storyAdAdmin) return;
  openModal('modal-story-review');
  $('story-review-list').innerHTML = '<div class="empty-list">Loading review queue…</div>';
  const { ok, data } = await api('/api/story-ads/review');
  if (!ok) { $('story-review-list').innerHTML = `<div class="empty-list">${esc(data.error || 'Could not load review queue')}</div>`; return; }
  const list = $('story-review-list');
  list.innerHTML = '';
  if (!data.campaigns?.length) list.innerHTML = '<div class="empty-list">No campaigns to review.</div>';
  else data.campaigns.forEach(campaign => list.appendChild(campaignCard(campaign, true)));
}

async function reviewCampaign(id, decision, waivePayment) {
  const message = waivePayment
    ? 'Granting account credit intentionally waives payment and may activate this ad. Continue?'
    : `${decision === 'approve' ? 'Approve' : 'Reject'} this campaign?`;
  if (!confirm(message)) return;
  let note = '';
  if (waivePayment) note = prompt('Required account-credit authorization reason:', 'Approved promotional account credit');
  else if (decision === 'reject') note = prompt('Reason shown to the advertiser:', 'Creative does not meet advertising policy');
  if ((waivePayment || decision === 'reject') && (note == null || !note.trim())) return;
  const { ok, data } = await api(`/api/story-ads/${encodeURIComponent(id)}/review`, { decision, waivePayment, note }, { method: 'PUT' });
  if (!ok) return toast(data.error || 'Could not review campaign');
  toast(waivePayment ? 'Approved with documented account credit' : `Campaign ${decision}d`);
  openStoryReview();
}

async function verifyReturnedBoostPayment() {
  const params = new URLSearchParams(location.search);
  if (params.get('boost_return') !== '1') return;
  const reference = params.get('reference') || params.get('trxref');
  params.delete('boost_return');
  params.delete('reference');
  params.delete('trxref');
  const remaining = params.toString();
  history.replaceState({}, '', `${location.pathname}${remaining ? `?${remaining}` : ''}${location.hash}`);
  if (!reference) return toast('Returned from checkout without a payment reference');
  const { ok, data } = await api(`/api/story-ads/payment/verify?reference=${encodeURIComponent(reference)}`);
  toast(ok ? 'Boost payment confirmed. Delivery starts after ad review.' : (data.error || 'Payment could not be verified'));
  if (ok) openStoryBoosts();
}

// ── Main menu ──────────────────────────────────────────────────────────
function mainMenu(e) {
  showCtxMenu(e, [
    { label: 'New group', fn: openNewGroup },
    { label: 'Status updates', fn: openStories },
    { label: document.body.classList.contains('reels-open') ? 'Close reels' : 'Reels · scroll while chatting', fn: toggleReels },
    { label: 'Profile', fn: openProfile },
    { label: 'Privacy & security', fn: openPrivacy },
    { label: 'Notifications & media', fn: openNotifications },
    { label: 'Archived', fn: () => setFilter('archived') },
    { label: 'Call quality', fn: openCallQuality },
    { label: 'Install app', fn: installApp },
    { label: lite ? 'Lite mode: on' : 'Lite mode: off', fn: openLiteMode },
    { sep: true },
    { label: document.body.classList.contains('dark') ? 'Light mode' : 'Dark mode', fn: toggleTheme },
    { sep: true },
    { label: 'Log out', danger: true, fn: async () => {
      localStorage.removeItem('vchat.token');
      try { await api('/api/auth/logout', {}); } catch { /* offline */ }
      location.reload();
    } },
  ]);
}

function chatMenu(e) {
  const c = activeChat();
  if (!c) return;
  const canManagePrivacy = c.type !== 'group' || (c.admins || []).includes(me.id);
  showCtxMenu(e, [
    { label: c.type === 'group' ? 'Group info' : 'Contact info', fn: openDrawer },
    { label: c.muted ? 'Unmute notifications' : 'Mute notifications', fn: () => socket.emit('chat:flag', { chatId: c.id, flag: 'muted', value: !c.muted }) },
    { label: c.favorite ? 'Remove from Favorites' : 'Add to Favorites', fn: () => socket.emit('chat:flag', { chatId: c.id, flag: 'favorite', value: !c.favorite }) },
    { label: c.archived ? 'Unarchive chat' : 'Archive chat', fn: () => { socket.emit('chat:flag', { chatId: c.id, flag: 'archived', value: !c.archived }); closeChat(); } },
    ...(canManagePrivacy ? [{ label: 'Disappearing messages', fn: () => chooseDisappearing(c) }] : []),
    ...(canManagePrivacy ? [{
      label: c.advancedPrivacy ? 'Turn off advanced chat privacy' : 'Turn on advanced chat privacy',
      fn: () => {
        const enabled = !c.advancedPrivacy;
        const detail = enabled
          ? 'This limits forwarding and attachment downloads from this chat. Turn it on?'
          : 'Allow forwarding and attachment downloads from this chat again?';
        if (!confirm(detail)) return;
        socket.emit('chat:setAdvancedPrivacy', { chatId: c.id, enabled }, result => result?.error && toast(result.error));
      },
    }] : []),
    { sep: true },
    { label: 'Clear messages', danger: true, fn: () => { if (confirm('Clear all messages?')) socket.emit('chat:clear', { chatId: c.id }); } },
    ...(c.id !== 'general' ? [{ label: c.type === 'group' ? 'Exit group' : 'Delete chat', danger: true, fn: () => { if (confirm('Are you sure?')) socket.emit('chat:leave', { chatId: c.id }); } }] : []),
  ]);
}

function chooseDisappearing(chat) {
  const answer = prompt('Disappearing messages: enter 0 (off), 1 (day), 7 (days), or 90 (days)', String((chat.disappearingSeconds || 0) / 86400));
  if (answer == null) return;
  const days = Number(answer);
  if (![0, 1, 7, 90].includes(days)) return toast('Choose 0, 1, 7, or 90 days');
  socket.emit('chat:setDisappearing', { chatId: chat.id, seconds: days * 86400 }, result => {
    if (result?.error) toast(result.error);
  });
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

// ── Calls (WebRTC) ─────────────────────────────────────────────────────
let ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302'] },
];
async function refreshIceServers() {
  try {
    const { ok, data } = await api('/api/calls/ice');
    if (ok && Array.isArray(data.iceServers) && data.iceServers.length) ICE_SERVERS = data.iceServers;
  } catch { /* STUN fallback remains available */ }
}

let call = null;        // { id, chatId, peer, media, role, state }
let pc = null;          // RTCPeerConnection
let localStream = null;
let pendingIce = [];
let ringTone = null;
let callTimer = null;
let callStart = 0;

function callSupported() {
  return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function callTone(kind, force = false) {
  callToneStop();
  if (!force && !notificationPrefs.callSounds) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume?.();
    const ctx = audioCtx;
    const gain = ctx.createGain();
    gain.gain.value = kind === 'ring' ? 0.05 : 0.035;
    gain.connect(ctx.destination);
    const ringtone = notificationPrefs.ringtone;
    const beat = () => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = ringtone === 'pulse' ? 'square' : 'sine';
      o.frequency.value = kind !== 'ring' ? 440 : ({ classic: 520, gentle: 392, pulse: 660 }[ringtone] || 520);
      o.connect(g); g.connect(gain);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (ringtone === 'gentle' ? 1.15 : 0.9));
      o.start(); o.stop(ctx.currentTime + 1.2);
    };
    beat();
    ringTone = { gain, timer: setInterval(beat, kind === 'ring' ? 2400 : 3000) };
  } catch (_) {}
}
function callToneStop() {
  if (!ringTone) return;
  clearInterval(ringTone.timer);
  try { ringTone.gain.disconnect(); } catch (_) {}
  ringTone = null;
}

function callDuration(secs) {
  const m = Math.floor(secs / 60), sec = secs % 60;
  const h = Math.floor(m / 60);
  if (h) return `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function callSetState(text) { $('call-state').textContent = text; }

function callTick() {
  clearInterval(callTimer);
  callStart = Date.now();
  const run = () => callSetState(callDuration(Math.floor((Date.now() - callStart) / 1000)));
  run();
  callTimer = setInterval(run, 1000);
}

function callShow(peer, media, state) {
  const screen = $('call-screen');
  $('call-name').textContent = peer?.username || 'Unknown';
  $('call-avatar-wrap').innerHTML = avatarHTML(peer, 140);
  screen.classList.add('on', 'ringing');
  screen.classList.toggle('has-local', media === 'video');
  screen.classList.remove('has-remote');
  $('call-cam').hidden = media !== 'video';
  $('call-mute').classList.remove('off');
  $('call-cam').classList.remove('off');
  callSetState(state);
}

function callHide() {
  const screen = $('call-screen');
  screen.classList.remove('on', 'ringing', 'has-local', 'has-remote');
  clearInterval(callTimer);
  callTimer = null;
}

function ringShow(from, media) {
  $('ring-name').textContent = from?.username || 'Unknown';
  $('ring-kind').textContent = `Incoming ${media === 'video' ? 'video' : 'voice'} call`;
  $('ring-avatar-wrap').innerHTML = avatarHTML(from, 64);
  $('ring').classList.add('on');
}
function ringHide() { $('ring').classList.remove('on'); }

async function getMedia(media) {
  // Lite mode asks for a smaller picture at the source, so there is less to encode.
  const size = lite ? { width: { ideal: 480 }, height: { ideal: 360 } }
                    : { width: { ideal: 1280 }, height: { ideal: 720 } };
  const want = media === 'video'
    ? { audio: true, video: { ...size, facingMode: 'user' } }
    : { audio: true, video: false };
  return navigator.mediaDevices.getUserMedia(want);
}

/**
 * Cap what the connection is allowed to spend. Opus stays intelligible far
 * below its default, and this is what turns an hour of talking into a few MB.
 */
function applyBitrateCap(conn) {
  if (!lite || !conn.getSenders) return;
  for (const sender of conn.getSenders()) {
    if (!sender.track || !sender.getParameters) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = sender.track.kind === 'audio' ? 16000 : 150000;
      sender.setParameters(params).catch(() => {});
    } catch { /* older browser — the call still works, just uncapped */ }
  }
}

function makePeer(callId) {
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  conn.onicecandidate = e => {
    if (e.candidate) socket.emit('call:signal', { callId, data: { ice: e.candidate } });
  };
  conn.ontrack = e => {
    const v = $('call-remote-video');
    if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
    if (e.track.kind === 'video') $('call-screen').classList.add('has-remote');
  };
  conn.onconnectionstatechange = () => {
    if (!call) return;
    if (conn.connectionState === 'connected' && call.state !== 'active') {
      call.state = 'active';
      $('call-screen').classList.remove('ringing');
      callToneStop();
      callTick();
    }
    if (conn.connectionState === 'failed') {
      toast('Call connection lost');
      hangUp();
    }
  };
  return conn;
}

function attachLocal(stream) {
  localStream = stream;
  const v = $('call-local-video');
  v.srcObject = stream;
  if (stream.getVideoTracks().length) $('call-screen').classList.add('has-local');
}

async function startCall(media) {
  pauseReelVideos();
  const c = activeChat();
  if (!c) return;
  if (c.type !== 'dm') return toast('Calls are one-to-one only');
  if (call) return toast('You are already on a call');
  if (!callSupported()) return toast('Calls are not supported in this browser');

  let stream;
  try {
    stream = await getMedia(media);
  } catch (err) {
    return toast(err && err.name === 'NotAllowedError'
      ? 'Microphone/camera permission denied'
      : 'No microphone or camera found');
  }

  socket.emit('call:start', { chatId: c.id, media }, res => {
    if (!res || res.error) {
      stream.getTracks().forEach(t => t.stop());
      return toast(res?.error || 'Could not start call');
    }
    call = { id: res.callId, chatId: c.id, peer: res.peer, media, role: 'caller', state: 'ringing' };
    attachLocal(stream);
    callShow(res.peer, media, 'Ringing…');
    callTone('dial');
  });
}

function onCallIncoming({ callId, chatId, media, from }) {
  if (call) return;  // server guards this, belt & braces
  pauseReelVideos();
  call = { id: callId, chatId, peer: from, media, role: 'callee', state: 'ringing' };
  ringShow(from, media);
  showCallNotification(from, media);
  callTone('ring');
}

async function acceptCall() {
  if (!call || call.role !== 'callee') return;
  ringHide();
  let stream;
  try {
    stream = await getMedia(call.media);
  } catch (_) {
    toast('Microphone/camera permission denied');
    socket.emit('call:decline', { callId: call.id });
    return teardown();
  }
  attachLocal(stream);
  callShow(call.peer, call.media, 'Connecting…');
  callToneStop();
  closeCallNotification();

  pc = makePeer(call.id);
  stream.getTracks().forEach(t => pc.addTrack(t, stream));
  applyBitrateCap(pc);
  socket.emit('call:accept', { callId: call.id });
}

function declineCall() {
  if (!call) return;
  socket.emit('call:decline', { callId: call.id });
  teardown();
}

async function onCallAccepted({ callId }) {
  if (!call || call.id !== callId || call.role !== 'caller') return;
  callToneStop();
  callSetState('Connecting…');
  pc = makePeer(callId);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  applyBitrateCap(pc);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('call:signal', { callId, data: { sdp: pc.localDescription } });
}

async function onCallSignal({ callId, data }) {
  if (!call || call.id !== callId || !data) return;
  try {
    if (data.sdp) {
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      for (const ice of pendingIce.splice(0)) {
        try { await pc.addIceCandidate(new RTCIceCandidate(ice)); } catch (_) {}
      }
      if (data.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call:signal', { callId, data: { sdp: pc.localDescription } });
      }
    } else if (data.ice) {
      if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.ice)); } catch (_) {}
      } else {
        pendingIce.push(data.ice);
      }
    }
  } catch (err) {
    console.error('signal error', err);
  }
}

function onCallEnded({ callId, reason, rateable }) {
  if (!call || call.id !== callId) return;
  const msg = {
    timeout: 'No answer',
    declined: 'Call declined',
    cancelled: 'Call cancelled',
    disconnected: 'Call disconnected',
  }[reason];
  if (msg) toast(msg);
  const info = callSummary();
  teardown();
  if (rateable) askForRating(info);
}

/** Snapshot the call before teardown wipes it, for the rating prompt. */
function callSummary() {
  if (!call) return null;
  return {
    callId: call.id,
    peer: call.peer,
    media: call.media,
    duration: callStart ? Math.round((Date.now() - callStart) / 1000) : 0,
    connected: call.state === 'active',
  };
}

function hangUp() {
  if (!call) return;
  const info = callSummary();
  if (call.role === 'caller' && call.state === 'ringing') socket.emit('call:cancel', { callId: call.id });
  else if (call.role === 'callee' && call.state === 'ringing') socket.emit('call:decline', { callId: call.id });
  else socket.emit('call:end', { callId: call.id });
  teardown();
  // Only worth asking about a call that actually connected.
  if (info && info.connected) askForRating(info);
}

function teardown() {
  callToneStop();
  closeCallNotification();
  ringHide();
  callHide();
  if (pc) { try { pc.close(); } catch (_) {} pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  pendingIce = [];
  const rv = $('call-remote-video'), lv = $('call-local-video');
  if (rv) rv.srcObject = null;
  if (lv) lv.srcObject = null;
  call = null;
  callStart = 0;
}

function toggleMute() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const b = $('call-mute');
  b.classList.toggle('off', !track.enabled);
  b.title = track.enabled ? 'Mute' : 'Unmute';
  b.innerHTML = icon(track.enabled ? 'mic' : 'mic-off');
}

function toggleCam() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const b = $('call-cam');
  b.classList.toggle('off', !track.enabled);
  b.title = track.enabled ? 'Turn camera off' : 'Turn camera on';
  b.innerHTML = icon(track.enabled ? 'video' : 'video-off');
  $('call-screen').classList.toggle('has-local', track.enabled);
}

function callLogHTML(m) {
  const info = m.call || {};
  const out = info.from === me.id;
  const video = info.media === 'video';
  const missed = info.outcome === 'missed' || info.outcome === 'declined';
  let title;
  if (info.outcome === 'missed') title = out ? `${video ? 'Video' : 'Voice'} call, no answer` : `Missed ${video ? 'video' : 'voice'} call`;
  else if (info.outcome === 'declined') title = out ? 'Call declined' : `Declined ${video ? 'video' : 'voice'} call`;
  else title = `${out ? 'Outgoing' : 'Incoming'} ${video ? 'video' : 'voice'} call`;
  const sub = info.duration ? callDuration(info.duration) : timeOf(m.timestamp);
  return `<div class="call-log ${missed ? 'missed' : ''}">
    <span class="call-ic">${icon(video ? 'video' : 'phone')}</span>
    <div class="call-log-main">
      <div class="call-log-title">${esc(title)}</div>
      <div class="call-log-sub">${esc(sub)}</div>
    </div></div>`;
}

function updateCallButtons() {
  const c = activeChat();
  const dm = !!c && c.type === 'dm';
  const show = dm && callSupported();
  $('btn-call-voice').style.display = show ? '' : 'none';
  // Video is the expensive one — lite mode hides it and leaves voice.
  $('btn-call-video').style.display = (show && !lite) ? '' : 'none';
}

// ── Call rating ────────────────────────────────────────────────────────
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
const RATE_WORDS = { 1: 'Terrible', 2: 'Bad', 3: 'Okay', 4: 'Good', 5: 'Great' };

// Set of calls we've already prompted for, so a hang-up race can't ask twice.
const ratedCalls = new Set();
let rating = null;   // { callId, peer, media, duration, stars, tags:Set }

/** Ask about the call that just ended. Only for calls that actually connected. */
function askForRating(info) {
  if (!info || !info.callId || ratedCalls.has(info.callId)) return;
  ratedCalls.add(info.callId);

  rating = { callId: info.callId, peer: info.peer, media: info.media, duration: info.duration || 0, stars: 0, tags: new Set() };

  $('rate-avatar-wrap').innerHTML = avatarHTML(info.peer, 64);
  const kind = info.media === 'video' ? 'Video call' : 'Voice call';
  $('rate-sub').textContent = info.duration
    ? `${kind} with ${info.peer?.username || 'them'} · ${callDuration(info.duration)}`
    : `${kind} with ${info.peer?.username || 'them'}`;

  // reset
  $('rate-stars').querySelectorAll('.star').forEach(b => {
    b.classList.remove('lit', 'pop');
    b.setAttribute('aria-checked', 'false');
  });
  $('rate-word').textContent = 'Tap a star to rate';
  $('rate-word').className = 'rate-word';
  $('rate-more').hidden = true;
  $('rate-note').value = '';
  $('rate-send').disabled = true;
  buildRatingTags();

  openModal('modal-rate');
}

function buildRatingTags() {
  const box = $('rate-tags');
  box.innerHTML = '';
  RATING_TAGS.forEach(tag => {
    const b = el('button', 'rate-tag', esc(tag));
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.onclick = () => {
      if (rating.tags.has(tag)) rating.tags.delete(tag);
      else rating.tags.add(tag);
      const on = rating.tags.has(tag);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    };
    box.appendChild(b);
  });
}

function setStars(n) {
  if (!rating) return;
  rating.stars = n;
  $('rate-stars').querySelectorAll('.star').forEach(b => {
    const lit = Number(b.dataset.star) <= n;
    b.classList.toggle('lit', lit);
    b.classList.toggle('pop', lit);
    b.setAttribute('aria-checked', String(Number(b.dataset.star) === n));
  });
  // The form can be torn down before this fires (submitting is fast).
  setTimeout(() => {
    const box = $('rate-stars');
    if (box) box.querySelectorAll('.star').forEach(b => b.classList.remove('pop'));
  }, 340);

  const w = $('rate-word');
  w.textContent = RATE_WORDS[n];
  w.className = 'rate-word ' + (n >= 4 ? 'good' : n <= 2 ? 'bad' : '');

  // Only chase the details when something went wrong — a 5-star call
  // shouldn't be interrogated.
  $('rate-ask').textContent = n <= 3 ? 'What went wrong?' : 'Anything we could do better?';
  $('rate-more').hidden = n === 5;
  $('rate-send').disabled = false;
}

function submitRating() {
  if (!rating || !rating.stars) return;
  const payload = {
    callId: rating.callId,
    stars: rating.stars,
    tags: [...rating.tags],
    note: $('rate-note').value.trim(),
  };
  socket.emit('call:rate', payload, res => {
    if (res && res.error) toast(res.error);
  });
  showRatingThanks();
  rating = null;
}

function showRatingThanks() {
  const body = $('modal-rate').querySelector('.modal-body');
  const keep = body.innerHTML;
  body.innerHTML = `<div class="rate-thanks">
      <div class="tick-big">${icon('check')}</div>
      <div class="rate-head">Thanks for the feedback</div>
      <div class="rate-sub">It helps us make calls better.</div>
    </div>`;
  $('modal-rate').querySelector('.modal-foot').style.visibility = 'hidden';
  setTimeout(() => {
    closeModal('modal-rate');
    body.innerHTML = keep;
    $('modal-rate').querySelector('.modal-foot').style.visibility = '';
    wireRatingStars();
  }, 1400);
}

function dismissRating() {
  rating = null;
  closeModal('modal-rate');
}

function wireRatingStars() {
  $('rate-stars').querySelectorAll('.star').forEach(b => {
    b.onclick = () => setStars(Number(b.dataset.star));
  });
  $('rate-send').onclick = () => submitRating();
  $('rate-skip').onclick = () => dismissRating();
  $('rate-note').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitRating(); };
}

/** Your own call-quality history, from the main menu. */
function openCallQuality() {
  socket.emit('call:ratings', {}, res => {
    if (!res || res.error) return toast(res?.error || 'Could not load call quality');
    if (!res.count) return toast('You have not rated any calls yet');
    const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
    const lines = [
      `${res.average} out of 5 across ${res.count} rated call${res.count === 1 ? '' : 's'}`,
      '',
      ...[5, 4, 3, 2, 1].map(n => `${stars(n)}  ${res.spread[n]}`),
    ];
    if (res.topIssues.length) {
      lines.push('', 'Most reported:', ...res.topIssues.slice(0, 3).map(i => `• ${i.tag} (${i.count})`));
    }
    alert(lines.join('\n'));
  });
}

// ── Wiring ─────────────────────────────────────────────────────────────
function wire() {
  $('btn-new-chat').onclick = openNewChat;
  $('btn-new-group').onclick = openNewGroup;
  $('btn-menu').onclick = mainMenu;
  $('btn-back').onclick = closeChat;
  $('btn-chat-menu').onclick = chatMenu;
  $('btn-stories').onclick = openStories;
  $('stories-close').onclick = closeStories;
  $('story-viewer-close').onclick = closeStoryViewer;
  $('story-create-button').onclick = openStoryComposer;
  $('story-empty-create').onclick = openStoryComposer;
  $('story-boosts-button').onclick = openStoryBoosts;
  $('story-review-button').onclick = openStoryReview;
  $('story-prev').onclick = showPreviousStory;
  $('story-next').onclick = () => showNextStory();
  $('story-delete').onclick = deleteCurrentStory;
  $('story-media-button').onclick = () => { $('story-file-input').value = ''; $('story-file-input').click(); };
  $('story-file-input').onchange = event => chooseStoryMedia(event.target.files?.[0]);
  $('story-media-remove').onclick = removeStoryMedia;
  $('story-text').oninput = updateStoryComposePreview;
  $('story-boost-toggle').onchange = event => { $('story-boost-fields').hidden = !event.target.checked; };
  $('boost-objective').onchange = event => { $('boost-url-row').hidden = event.target.value !== 'website_visits'; };
  $('boost-budget').oninput = updateBoostEstimate;
  $('boost-days').onchange = updateBoostEstimate;
  $('story-publish').onclick = publishStory;
  document.querySelectorAll('[data-story-color]').forEach(button => {
    button.onclick = () => {
      storyBackground = button.dataset.storyColor;
      document.querySelectorAll('[data-story-color]').forEach(choice => choice.classList.toggle('selected', choice === button));
      updateStoryComposePreview();
    };
  });
  $('btn-reels').onclick = toggleReels;
  $('btn-reels-chat').onclick = toggleReels;
  $('reels-close').onclick = closeReels;
  $('reel-upload-button').onclick = chooseReelFile;
  $('reel-file-input').onchange = event => prepareReelUpload(event.target.files?.[0]);
  $('reel-publish').onclick = publishReel;
  $('reels-feed').addEventListener('scroll', () => {
    const feed = $('reels-feed');
    if (!reelsLoading && !reelsExhausted && feed.scrollHeight - feed.scrollTop < feed.clientHeight * 2.25) {
      loadReels(false, true);
    }
  }, { passive: true });
  $('btn-call-voice').onclick = () => startCall('audio');
  $('btn-call-video').onclick = () => startCall('video');
  $('call-hangup').onclick = () => hangUp();
  $('call-mute').onclick = () => toggleMute();
  $('call-cam').onclick = () => toggleCam();
  $('ring-accept').onclick = () => acceptCall();
  wireRatingStars();
  $('ring-decline').onclick = () => declineCall();
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (call && $('ring').classList.contains('on')) declineCall();
    else if ($('modal-story-compose').classList.contains('show')) closeModal('modal-story-compose');
    else if (!$('story-viewer').hidden) closeStoryViewer();
    else if ($('stories-screen').classList.contains('open')) closeStories();
    else if ($('modal-reel-upload').classList.contains('show')) closeModal('modal-reel-upload');
    else if (document.body.classList.contains('reels-open')) closeReels();
  });

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
loadOutbox();
document.body.classList.toggle('lite', lite);
// The browser tells us before the socket does.
window.addEventListener('online', () => flushOutbox());
window.addEventListener('offline', () => updateOfflineBar());
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
initLogin();
wire();

})();
