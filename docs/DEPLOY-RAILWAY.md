# Deploy VChat to Railway

VChat is a real-time WhatsApp-style messenger: the server holds live WebSocket
connections and writes chat history + uploads to disk, so it needs a host that
runs Node 24/7 (not a static/serverless host like Vercel). Railway does exactly
that, and this app runs on it with **zero paid services** — sign-in uses a code
shown on screen until you add Twilio later.

Cost: Railway's free trial ($5 credit, no card) covers a small app for a while;
after that the Hobby plan is ~$5/month. See the note at the end for a $0 option.

## 1. Push this branch

Deploy from the `arena/019ffbf9-valmont-chat` branch (or merge it to `main`).

## 2. Create the project

1. Go to <https://railway.app> and sign in with GitHub.
2. **New Project → Deploy from GitHub repo**.
3. Pick `danieloansah7868-dotcom/Valmont-chat`.
4. Railway detects Node and uses the `railway.json` in this repo (Nixpacks,
   `npm start`, healthcheck on `/api/health`). Click **Deploy**.

## 3. Attach persistent volumes (required)

This is what keeps chat history and shared photos across restarts and redeploys.
The app writes state to two folders, so add **two** volumes:

| Mount path | What it stores |
| --- | --- |
| `/app/data` | Accounts, chats, messages (`data/db.json`) |
| `/app/public/uploads` | Photos, videos, voice notes, documents |

In **Service → Settings → Volumes → Add volume**, create both. If Railway runs
your app from a directory other than `/app`, adjust the mount paths to
`<app-dir>/data` and `<app-dir>/public/uploads`.

## 4. Environment variables

None are required to start. You can optionally set `NODE_ENV=production`.
Leave `PORT` unset — Railway injects it.

Sign-in works immediately in "dev mode": enter a phone number and the 6-digit
code appears on the next screen (and in the service logs).

## 5. Open it

Railway gives you a URL like `https://vchat-production-xxxx.up.railway.app`.
Open it, pick your country, enter a phone number, enter the code shown on
screen, create your account, and start chatting. Try two devices/numbers to see
messages arrive live.

## 6. Later, when you have money — turn on real SMS

1. Create a Twilio project and set these three variables:
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`
2. Redeploy. Codes now go out as real SMS automatically — no code changes.

(Everything else — calls, media, groups, voice notes — already works for free:
calls use public STUN, and media is stored on the volume you mounted.)

## $0 alternative (your own computer + a free tunnel)

If you'd rather not pay at all, run the same app at home and expose it with a
free tunnel. Your computer must stay switched on and online:

```bash
npm install
npm start
```

then in a second terminal run a tunnel (e.g. Cloudflare Tunnel, `ngrok`, or
`localhost.run`) pointed at port 3000.

## Notes

- The app is a **single-node** server (state lives in `data/db.json` + memory).
  Keep it to one instance; don't add replicas.
- **The on-screen code is for a trusted group.** Anyone who knows a phone number
  can read its code from the screen. Switch to Twilio before opening the app to
  the public.
- Calls are browser-to-browser over free STUN and work for most home/office
  networks; behind a strict corporate NAT you'd add a TURN relay later.
