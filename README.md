# Vchat

Vchat is a responsive, installable web messenger built with Node.js, Express,
Socket.IO, WebRTC, and a framework-free browser client.

> **Security status:** the current phase protects authentication cookies, API and
> Socket.IO authorization, account privacy settings, and chat-bound media access.
> Message text and media are still readable by the server. End-to-end encryption
> (E2EE), encrypted backups, and safety-number verification are **not complete**.
> Do not describe this release as end-to-end encrypted.

Meta AI and general WhatsApp Business/commerce features are intentionally out of
scope. Status advertising and user-initiated boosted Status posts are the explicit
advertising exception. The website remains installable as a PWA. A real Android
APK, desktop window, and iOS WebView shell live under `native/` so VChat can ship
as an application, not only as a browser tab.

## Run locally

Vchat requires Node.js 20 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>. In local development, when Twilio is not configured,
the six-digit verification code is logged by the server and returned to the local
sign-in screen. For a deployed app, set `SMS_DEV_CODE=true` to keep that on-screen
fallback (fine for a small trusted group), or configure Twilio for real SMS.
Never expose the on-screen fallback publicly.

Useful commands:

```bash
npm run check            # parse all server and browser JavaScript
npm test                 # security and integration tests
npm audit --omit=dev     # production dependency audit
```

## Enable real SMS verification

Vchat currently sends production verification messages through Twilio's Messaging
API. Create a funded Twilio project, obtain an SMS-capable sender that can reach the
countries you enable, and set all three values in the deployment secret manager:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_server_only_auth_token
TWILIO_FROM=+1xxxxxxxxxx
NODE_ENV=production
```

`TWILIO_FROM` must be a Twilio sender/number authorized for the destination; enable
its required geographic permissions and comply with sender-registration rules in
each market. Twilio trial projects generally deliver only to recipient numbers that
you have verified with Twilio, so use a production project before public testing.
Never place the Auth Token in browser JavaScript or commit it to Git.

After redeploying, request a code using a real E.164 number such as
`+233501234567` and inspect Twilio's message logs if delivery fails. The application
generates a cryptographically random six-digit code, stores only a salted hash,
expires it after five minutes, limits resends and guesses, and consumes successful
verification. In `NODE_ENV=production`, missing or incomplete Twilio configuration
returns HTTP 503 unless `SMS_DEV_CODE=true` explicitly opts in to on-screen codes.

The current OTP state is process-local. A single production server can use it, but
a multi-instance deployment must move pending-code, attempt, and resend state to a
shared atomic store such as Redis before traffic is load-balanced across instances.

## Implemented foundation

### Accounts and privacy

- Phone-number registration and six-digit verification codes with expiry, resend
  limits, and attempt limits; each new registration chooses an immutable Personal
  or Business account type while retaining the same phone sign-in
- Unique public `@username` chosen at sign-up. Friends search that handle — never
  a phone number — to start a chat. Handles are 3–20 characters, start with a
  letter, and use only letters, numbers or `_`
- Business accounts have a public business-purpose page (name, category,
  description, HTTPS website, contact details, address, and hours) plus an owner
  dashboard linked to Status boosting. Catalogs, carts, and shopping are not part
  of this phase.
- Opaque 256-bit session tokens stored server-side only as SHA-256 digests
- Strict `HttpOnly`, `SameSite=Strict` session cookies; secure `__Host-` cookies in
  production
- Linked-device/session listing, individual revocation, and logout of all other
  sessions
- Six-digit two-step PIN setup, authenticated changes, and authenticated removal;
  PINs use salted `scrypt`
- Names with emoji, fallback emoji avatars, and protected JPEG/PNG/WebP profile
  photos whose delivery honors profile-photo privacy
- Last-seen, online, profile-photo, about, read-receipt, unknown-caller, default
  disappearing-message, and advanced-privacy preferences
- Contact blocking and abuse reporting
- Privacy-aware public user projections that never expose phone numbers

### Messaging and groups

- Authorized direct chats and groups over Socket.IO
- Optimistic sending with a persistent browser outbox and idempotent client IDs
- Delivery/read receipts, replies, reactions, editing, delete-for-me/everyone,
  starring, forwarding to at most five chats, and temporary message pins
- Lightweight escaped rich text, code spans/blocks, links, forwarded labels, and
  disappearing-message indicators
- Favorites, pin, mute, archive, manual unread, chat search, and message search;
  pin/archive/mute remain available alongside chat-lock controls
- Per-account hidden chats whose rows, previews, history, media, search results,
  calls, and realtime rooms remain unavailable until the current session is
  unlocked. Unlock uses a separate salted-`scrypt` six-digit chat-lock PIN or a
  device biometric/screen lock/security key through WebAuthn passkeys, expires
  automatically after a bounded interval, and never unlocks other device sessions.
- A searchable, categorized emoji picker spanning smileys, people, animals, food,
  activities, travel, objects, symbols, and flags
- Group admin roles, participant add/remove, invite-link reset and join,
  admin/member permissions, descriptions, and disappearing-message controls
- Advanced chat privacy that disables Vchat forwarding/download actions for that
  chat (this is a product control, not DRM)

### Protected media and calls

- Chat-bound attachment IDs and authorization checks on every media request
- Media stored outside the public web root; legacy `/uploads` access is explicitly
  denied
- One-use upload claims and safe attachment metadata cloning when a message is
  forwarded to another authorized chat
- WhatsApp-style View Once for chat photos and videos: ordinary recipient media
  URLs are withheld, every recipient gets one independent server-side opening,
  and Vchat forward/download actions are disabled. An opening uses a short-lived,
  authenticated, `no-store` media grant; this is a product/privacy control rather
  than DRM and cannot prevent an external camera or a modified device.
- Image compression, inline image/video/audio, documents, voice recording and
  playback, and authenticated downloads
- One-to-one WebRTC voice/video calls with dynamic STUN/TURN configuration, call
  controls, logs, timeouts, and quality feedback

### Reels

- Authenticated MP4, MOV, and WebM uploads with configurable size/rate limits,
  container-signature checks, protected storage, and failed-upload cleanup
- A cursor-paginated, vertically snapping feed with muted in-view autoplay,
  explicit play/sound controls, captions, likes, and owner-only deletion; Lite
  mode and reduced-motion preferences disable autoplay
- Block-aware visibility and protected video delivery with `private, no-store`
  caching; generic realtime refresh notices do not expose Reel IDs
- A desktop companion pane and an independently scrollable mobile chat/Reels
  split, so opening a Reel owner's direct chat does not close the feed

Reels currently share the transitional local media store. There is no object-store
replication, transcoding ladder, malware/content-moderation pipeline, CDN, or DRM;
those production-scale controls belong in the infrastructure phase.

### Status and Story advertising pilot

- Users can publish text, JPEG/PNG/WebP, MP4/MOV/WebM Status posts. Posts expire
  after 24 hours and are visible only when both accounts are known contacts; blocks
  apply in both directions. Each post has an **Allow viewers to save** switch.
  Vchat exposes an authenticated Save action only when that owner permission is on;
  the composer explicitly warns that screenshots and screen recording cannot be
  prevented.
- The full-screen viewer plays friends' posts sequentially, records protected views
  and reactions, shows owner-only counts, and resumes organic playback after a
  clearly disclosed **Sponsored** Vchat house Story. Sponsored slots run for 30
  visible seconds and cannot be advanced early with the next control.
- Status media is signature-checked, stored outside the public tree, authorized on
  every request, served with `private, no-store`, and removed after deletion or
  expiry. Generic realtime notices do not expose Story or owner IDs.
- The final composer step includes **Boost post**. The pilot captures objective,
  CTA, optional HTTPS destination, broad/contact audience, duration, fixed GHS
  campaign reservation, and billing email. Uploaded creative is copied into a
  campaign-owned protected object so normal 24-hour Story cleanup cannot remove an
  approved ad.
- Redirect checkout is initialized only on the server through the tenant-scoped
  ValmontPay API. References, GHS currency, and exact major-unit amounts are
  reverified server-side; webhooks use `x-valmontpay-signature` with HMAC-SHA256
  over the exact raw body. Failed checkout initialization can be retried from **My
  boosts**; browser callback parameters never activate delivery.
- Delivery requires both advertising review and either verified payment or an
  intentional administrator account-credit waiver with a documented reason. Owners
  can pause, resume, or permanently stop delivery; administrators can stop active
  delivery for safety only with a required advertiser-visible audit reason.
  Review/control actor and time data are retained, and owners can view deduplicated
  reach, impressions, clicks, review notes, and billing state. Stopping does not
  automatically create a refund.
- Active broad campaigns are returned to eligible signed-in users even when they
  are not contacts and have no friend Status to open. A standalone Sponsored
  discovery tray makes that inventory reachable from the Status home screen while
  still excluding the advertiser, honoring blocks and contact-only targeting, and
  requiring the same review, payment, pause/stop, and reservation lifecycle.

This is an honest first-party advertiser pilot, not a finished ad exchange. The
GHS amount is a fixed campaign reservation rather than metered auction spend; it
carries no delivery or results guarantee. There is no auction, CPM/CPC billing,
inventory forecast, budget pacing, frequency cap, refund automation, conversion
attribution, advanced geography/demographic model,
creative malware/transcoding service, independent fraud detection, or scaled human
moderation operation yet. Keep paid delivery disabled until policy, support,
refund, and operational controls appropriate to the deployment are in place.

### Web app

- Responsive two-pane/mobile interface, light/dark themes, Lite mode, and a
  per-device chat wallpaper picker (presets or your own photo)
- Per-device message notification, preview, message-tone, ringtone, call-sound,
  and media-preview controls; browser alerts work while Vchat is open
- Received media remains in protected chats; explicit saves use the browser's
  Downloads location because a web PWA cannot write to the device gallery
- Direct-message **Cloud | SMS** switch: Cloud bubbles are navy, SMS bubbles are
  orange. SMS still leaves through Twilio on the server
- Installable manifest, maskable icons, deferred install prompt, and an app-shell
  service worker
- The worker deliberately never caches account, message, Socket.IO, or protected
  media responses
- Hardened CSP and Helmet headers, same-origin mutation checks, Socket.IO origin
  checks, request-size limits, and API/auth rate limiting

## PWA vs a real app

The service worker caches only the static shell. It can reopen the sign-in/chat
shell while offline, but messages still require the server and are not copied into
Cache Storage. Messages composed while disconnected remain in the existing local
outbox and retry when the socket reconnects.

**Add to Home Screen** is still a website. A real app is an APK, desktop installer,
or iOS archive:

- Android: open `native/android` in Android Studio, set `vchat.server.url`, build
  an APK. Play Store listing needs a Google Play developer account.
- Desktop: `cd native/desktop && npm install && VCHAT_SERVER_URL=https://your-host npm start`
- iOS: drop `native/ios` into an Xcode app on a Mac. App Store listing needs a
  paid Apple Developer account.

The native shells are full-screen WebViews of your hosted VChat origin. They add
`VChatNative/1.0` to the user agent so the site hides the PWA install prompt.
They do not become iMessage, WhatsApp's native stack, or the phone Messages app.
In-app guide: `/native-app.html` or **Menu → Get the VChat app**.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `3000` |
| `NODE_ENV` | Enables production cookie/HSTS behavior when `production` | unset |
| `COOKIE_SECURE` | Explicit secure-cookie override | production-dependent |
| `SESSION_COOKIE_NAME` | Session cookie name | `__Host-vchat_session` in secure mode |
| `SESSION_TTL_DAYS` | Session lifetime | `30` |
| `ALLOWED_ORIGINS` | Comma-separated additional browser origins | same host only |
| `TRUST_PROXY` | Explicit Express proxy hop count or trusted subnet | disabled |
| `API_RATE_LIMIT` | API requests per minute per client | `240` |
| `AUTH_RATE_LIMIT` | Authentication requests per 15 minutes | `20` |
| `VCHAT_DATA_DIR` | Transitional database and media root | `./data` |
| `VCHAT_MEDIA_DIR` | Protected media storage override | `$VCHAT_DATA_DIR/media` |
| `MAX_UPLOAD_MB` | Maximum chat attachment size | `100` |
| `REEL_MAX_MB` | Maximum Reel video size (clamped to 1–200 MB) | `50` |
| `REEL_UPLOAD_LIMIT` | Reel upload attempts per client IP per hour (clamped to 1–500) | `20` |
| `STORY_MAX_MB` | Maximum Status image/video size (clamped to 1–100 MB) | `30` |
| `STORY_UPLOAD_LIMIT` | Status publish attempts per client IP per day (clamped to 1–200) | `30` |
| `STORY_HOUSE_AD_NAME` | Disclosed house-ad advertiser name | `Vchat` |
| `STORY_HOUSE_AD_HEADLINE` | House-ad headline | Vchat copy |
| `STORY_HOUSE_AD_TEXT` | House-ad body copy | Vchat copy |
| `STORY_HOUSE_AD_CTA` | House-ad CTA label | `Learn more` |
| `STORY_HOUSE_AD_URL` | Optional HTTPS/HTTP house-ad destination | unset |
| `STORY_AD_ADMIN_PHONES` | E.164 numbers authorized to review ads, grant credit, and safety-stop delivery | unset |
| `VALMONTPAY_SECRET_KEY` | Server-only ValmontPay tenant key for checkout, verification, and webhook signatures | unset |
| `VALMONTPAY_API_URL` | ValmontPay API origin | `https://valmontpay.app` |
| `PUBLIC_APP_URL` | Canonical HTTPS application URL used for the ValmontPay checkout return | unset |
| `PASSKEY_ORIGIN` | Exact canonical browser origin allowed for WebAuthn ceremonies | request origin |
| `PASSKEY_RP_ID` | WebAuthn relying-party domain (must match the origin host or a parent domain) | origin host |
| `TWILIO_ACCOUNT_SID` | Server-only Twilio account SID for real verification SMS | optional |
| `TWILIO_AUTH_TOKEN` | Server-only Twilio API secret | optional |
| `TWILIO_FROM` | SMS-capable Twilio sender in E.164 format | optional |
| `SMS_DEV_CODE` | `true` shows the verification code on screen when Twilio is unset (trusted groups only) | unset |
| `TURN_URLS` | Comma-separated TURN URLs | STUN only |
| `TURN_SECRET` | HMAC secret for temporary TURN credentials | unset |

For internet deployment, terminate TLS at a trusted reverse proxy, set
`NODE_ENV=production`, set `TRUST_PROXY` to the exact proxy hop count or subnet,
and keep `data/` on encrypted persistent storage until the database/object-storage
phase replaces it. Twilio, TURN, passkeys, and the ValmontPay pilot are optional:
leave them unset and set `SMS_DEV_CODE=true` for a free single-node deployment
(with on-screen verification codes); add them later without redeploying. If you
use passkeys, set `PASSKEY_ORIGIN` and `PASSKEY_RP_ID` to the canonical HTTPS
deployment identity.
Changing the passkey RP ID later invalidates existing passkeys, so establish the
production domain before enrollment. If the advertiser pilot is intentionally
enabled, set an HTTPS `PUBLIC_APP_URL`,
store `VALMONTPAY_SECRET_KEY` only in the server secret manager, register
`/api/story-ads/valmontpay/webhook` as the tenant webhook at ValmontPay, tightly
control `STORY_AD_ADMIN_PHONES`, publish ad/review/refund policies, and verify the
signed webhook path through every proxy before accepting money. This integration
uses HMAC-SHA256 because that is the supplied `x-valmontpay-signature` algorithm;
confirm the tenant configuration uses the same algorithm before going live.

## Storage and security model

`lib/messenger-store.js` is a transitional schema-v2 adapter. It keeps live state in
one process and writes a mode-`0600` snapshot to `data/db.v2.json`. It intentionally
never imports the legacy schema-v1 `data/db.json`; the approved migration policy is
a secure reset. Protected attachments, profile photos, and Reel videos live under
`data/media`; Reel, 24-hour Status, and campaign-creative metadata plus engagement
sets/maps are serialized into the schema-v2 snapshot. Expired Status files and
ended/stale campaign creative files are pruned by the single-node maintenance loop.

This adapter is suitable for deterministic local development and phased feature
work, not horizontal production scale. It has no multi-process consistency,
transactional database, object-storage durability, Redis fan-out, or disaster
recovery.

## Project layout

```text
server.js                  Express/Helmet bootstrap and HTTP server
lib/http-auth.js           Cookie parsing and session authentication
lib/messenger.js           Authenticated REST, media, Socket.IO, and call signaling
lib/messenger-store.js     Transitional schema-v2 data/service adapter
lib/sms.js                 Twilio or local-only verification transport
index.html                 Application markup and SVG icon sprite
public/app.js              Browser client
public/app.css             Responsive themes and component styles
public/manifest.webmanifest
public/sw.js               Static-shell-only service worker
public/icons/              PWA icons
test/                      Security and HTTP integration tests
Dockerfile                 Single-node pilot image
compose.pilot.yml          Persistent volume + healthcheck compose file
.env.production.example    Server-only production environment template
docs/operations.md         Pilot deploy, proxy, backup, and scaling notes
```

## Delivery roadmap

The requested WhatsApp-class scope is being delivered in production-oriented phases
rather than as nonfunctional demo screens:

1. **Security and messaging foundation (completed for the transitional single-node
   stage):** cookie sessions, media authorization, privacy controls, linked devices,
   advanced groups, profile/notification/media controls, PWA shell, and integration
   tests.
2. **Cryptographic phase:** audited multi-device E2EE protocol integration,
   pre-key service, encrypted media keys, device verification, key-change alerts,
   encrypted backup/restore, and secure history synchronization.
3. **Conversation surfaces (in progress):** the transitional Status/Story and
   first-party boost pilot described above is implemented; Channels, Communities,
   broadcasts/custom lists, events and polls, richer media/view-once behavior,
   personalization, and accessibility hardening remain.
4. **Advertiser operations:** policy tooling, moderation queues and audit logs,
   advertiser verification, fraud/abuse response, inventory forecasting, pacing,
   frequency caps, attribution, refunds, tax/accounting controls, and production
   reporting exports.
5. **Production infrastructure and calling:** PostgreSQL, Redis, object storage,
   jobs/notifications, observability, abuse operations, backup recovery, and an
   SFU/TURN architecture for scalable group calls, screen sharing, and waiting
   rooms.

Until phases 2–5 land and receive independent review, Vchat should be treated as a
securely staged development system—not a finished WhatsApp replacement.
