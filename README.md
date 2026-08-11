# VChat

A real-time chat app with a WhatsApp-style interface. Node + Express + Socket.IO on the
back end, vanilla JS on the front end — no build step, no framework.

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:3000>. Pick a display name and an avatar and you're in.
To try a conversation, open a second browser (or a private window) and join as someone else.

Set a different port with `PORT=8080 npm start`.

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
- Send images, video, audio, and documents up to 25 MB
- Drag-and-drop onto the window, paste from clipboard, or use the attach menu
- Inline photo bubbles with a full-screen lightbox and download link

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
| `POST` | `/api/messenger/upload` | Multipart upload (field `file`) → `{url, name, size, mimeType}` |
| `GET` | `/api/messenger/users` | All known users |
| `GET` | `/api/messenger/chats?userId=` | Chats visible to a user |
| `GET` | `/api/messenger/messages/:chatId?userId=&limit=` | Message history |
| `GET` | `/api/health` | Health check |

## Socket events

**Client → server:** `user:join`, `profile:update`, `message:send`, `message:edit`,
`message:delete`, `message:react`, `messages:read`, `typing:start`, `typing:stop`,
`chat:createGroup`, `chat:startDM`, `chat:open`, `chat:flag`, `chat:clear`, `chat:leave`,
`chat:addMembers`, `search:messages`

**Server → client:** `chats:list`, `chats:refresh`, `chat:new`, `chat:removed`,
`chat:cleared`, `message:new`, `message:updated`, `message:removed`, `messages:delivered`,
`messages:read`, `typing:start`, `typing:stop`, `users:list`, `presence:update`

## Notes

There are no passwords — anyone who can reach the server can join under any unused name.
It's built for a trusted network (a team, a classroom, a LAN), not the open internet.
