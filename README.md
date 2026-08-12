# VChat

A real-time chat app with a WhatsApp-style interface. Node + Express + Socket.IO on the
back end, vanilla JS on the front end — no build step, no framework.

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:3000> and sign in with your phone number. Without an SMS
provider configured the app runs in **dev mode**: the verification code is printed to
the server console and shown on the code screen, so you can sign in offline.

To try a conversation, open a second browser (or a private window) and sign in with a
different number.

Set a different port with `PORT=8080 npm start`.

## Signing in

Sign-in is by phone number, WhatsApp-style:

1. Pick your country and enter your number — it is normalised to E.164 (`+233241112233`).
2. Enter the 6-digit code sent to that number.
3. First time on a number, create an account: display name, unique `@username`, and
   avatar. Friends find you by that username, not your phone number. After that the
   number signs you straight back into the same account.

The session token is kept in `localStorage`, so you stay signed in across reloads
until you log out.

### Real SMS

Set these environment variables to send codes through Twilio:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_FROM=+15551234567
```

With none of them set, codes go to the console instead. Codes are 6 digits, stored
only as a salted SHA-256 hash, expire after 5 minutes, allow 5 attempts, and are rate
limited to one every 30 seconds and 5 per number per hour.

## Features

**Messaging**
- Instant delivery over WebSockets, with optimistic send and a pending clock icon
- Delivery receipts: clock → single tick → double tick → blue double tick when read
- Reply to any message with a quoted preview that jumps to the original on tap
- Emoji reactions, edit your own messages, delete for me / delete for everyone
- "X is typing…" indicators in both the conversation header and the chat list
- Messages grouped by sender and split by day dividers ("Today", "Yesterday", dates)
- Large emoji rendering when a message is only emoji, and automatic link detection

**Chats**
- One-to-one DMs and group chats with participant management
- Pin, mute, archive, clear history, and leave, from a right-click or the ⌄ menu
- Filter the list by All / Unread / Groups / Archived
- Search chats by name, search contacts to start a new DM, or search every message
  you can see with matches highlighted in place
- Unread badges per chat plus an unread counter in the browser tab title

**Media**
- Voice notes: hold the mic to record, with a live waveform and running timer,
  then send or discard. Playback bubbles have their own play/pause and seek bar.
- Photos are compressed in the browser before upload — resized to fit 1600px and
  re-encoded, so a 5 MB phone photo becomes a few hundred KB. Transparent PNGs
  stay PNG, GIFs keep their animation, and the original is sent if anything fails.
- Send images, video, audio, and documents up to 25 MB
- Drag-and-drop onto the window, paste from clipboard, or use the attach menu
- Inline photo bubbles with a full-screen lightbox and download link

**Calls**
- One-to-one voice and video calls, straight from the conversation header
- The phone and camera buttons only appear in DMs, on browsers that support WebRTC
- Incoming calls slide in as a banner you can accept or decline without leaving
  the chat you're in; a ringtone plays until someone answers
- In-call controls for mute and camera, a picture-in-picture self view, and a
  live call timer
- Every call is written into the conversation afterwards — outgoing, incoming,
  missed, declined, with its duration, exactly like WhatsApp does
- Unanswered calls stop ringing after 45 seconds, and closing your last tab
  mid-call hangs up for the other side

**Interface**
- WhatsApp-style two-pane layout that collapses to a single pane on mobile
- Light and dark themes, remembered between visits
- Contact and group info drawer, profile editor, notification sound
- Presence: online indicators and "last seen" timestamps

## Project layout

```
server.js               Express app, static assets, HTTP server bootstrap
lib/messenger.js        Socket.IO event handlers, upload + REST endpoints
lib/messenger-store.js  In-memory store for users, chats, and messages
index.html              Client markup and the inline SVG icon sprite
public/app.js           All client logic (single IIFE, no dependencies)
public/app.css          Styling and theme variables
public/uploads/         Uploaded files (gitignored)
data/db.json            Persisted state, written debounced on change (gitignored)
```

State lives in memory and is mirrored to `data/db.json`, so a restart keeps your
conversations. Delete that file to start from a clean slate.

## HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/request-code` | `{dialCode, number}` → sends a code, `{phone, registered, username, delivered, devCode}` |
| `POST` | `/api/auth/verify` | `{phone, code}` → `{token, user}`, or `{needsProfile: true}` for a new number |
| `POST` | `/api/auth/register` | `{phone, username, avatar}` → `{token, user}` (needs a recent verification) |
| `POST` | `/api/auth/session` | `{token}` → `{user}`, for resuming a session |
| `POST` | `/api/auth/logout` | `{token}` → `{ok: true}` |
| `POST` | `/api/messenger/upload` | Multipart upload (field `file`) → `{url, name, size, mimeType}` |
| `GET` | `/api/messenger/users` | All known users (no phone numbers) |
| `GET` | `/api/messenger/users/search?q=` | Look up people by `@username` |
| `GET` | `/api/messenger/chats?userId=` | Chats visible to a user |
| `GET` | `/api/messenger/messages/:chatId?userId=&limit=` | Message history |
| `GET` | `/api/health` | Health check |

## Socket events

**Client → server:** `user:join`, `profile:update`, `message:send`, `message:edit`,
`message:delete`, `message:react`, `messages:read`, `typing:start`, `typing:stop`,
`chat:createGroup`, `chat:startDM`, `chat:open`, `chat:flag`, `chat:clear`, `chat:leave`,
`chat:addMembers`, `search:messages`, `users:lookup`, `call:start`, `call:accept`, `call:decline`,
`call:cancel`, `call:end`, `call:signal`

**Server → client:** `chats:list`, `chats:refresh`, `chat:new`, `chat:removed`,
`chat:cleared`, `message:new`, `message:updated`, `message:removed`, `messages:delivered`,
`messages:read`, `typing:start`, `typing:stop`, `users:list`, `presence:update`,
`call:incoming`, `call:accepted`, `call:ended`, `call:signal`

## How calls work

Calls are peer to peer. The server only passes SDP offers, answers, and ICE
candidates between the two people on the call — audio and video never touch it,
so a call costs the server almost nothing and nobody in the middle can listen in.

Two consequences worth knowing:

- **Calls need HTTPS.** Browsers only hand out the microphone and camera in a
  secure context, so calling works on `localhost` and on any HTTPS deployment,
  but not over plain `http://` to another machine.
- **Only public STUN is configured.** Google's STUN servers are enough for most
  home and office networks. Behind a symmetric NAT or a strict corporate
  firewall, the two browsers may never find a path to each other, and you'd need
  to add a TURN relay to `ICE_SERVERS` in `public/app.js`.

Group calls are deliberately not supported — mixing more than two streams needs
a media server (an SFU), which is a different piece of software than this one.
Calls are also in-memory only: restarting the server drops any call in progress.

## Notes

Accounts are tied to a phone number and there are no passwords — whoever receives the
code owns the account. In dev mode the code is handed straight to the caller, so
configure Twilio before exposing the server to anyone you don't trust.
It's built for a trusted network (a team, a classroom, a LAN), not the open internet.
