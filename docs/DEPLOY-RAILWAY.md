# Deploy VChat to Railway

Railway runs Node as a long-lived process (WebSockets stay open, chat history and
uploads live on an attached volume), which is exactly what VChat needs. This guide
deploys the full app **without any paid services** — sign-in uses an on-screen code
until you add Twilio later.

Cost: Railway's free trial ($5 credit, no card) covers a small app for a while;
after that the Hobby plan is ~$5/month. See the note at the end if you want $0.

## 1. Push this branch

Deploy from the `arena/019ffbf9-valmont-chat` branch (or merge it to `main` first).
Everything below assumes the repo is on GitHub.

## 2. Create the project

1. Go to <https://railway.app> and sign in with GitHub.
2. **New Project → Deploy from GitHub repo**.
3. Pick `danieloansah7868-dotcom/Valmont-chat`.
4. Railway detects it as Node and uses the `railway.json` in this repo
   (Nixpacks, `npm start`, healthcheck on `/healthz`). Click **Deploy**.

## 3. Attach a persistent volume (required)

This is the storage that keeps chat history and uploads across restarts.

1. In the project, open your **VChat service → Settings → Volumes → Add volume**.
2. Mount path: `/var/lib/vchat`
3. Railway serves over HTTPS automatically, so nothing else is needed for TLS.

## 4. Set environment variables

In **Service → Variables**, add these (the money-free minimum):

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` |
| `ALLOW_TRANSITIONAL_LOCAL_STORAGE` | `true` |
| `WEB_CONCURRENCY` | `1` |
| `VCHAT_DATA_DIR` | `/var/lib/vchat` |
| `SMS_DEV_CODE` | `true` |

Leave `PORT` unset — Railway injects it. If the deploy shows "Runtime configuration
is unsafe", check the build logs: the app prints the exact missing variable.

## 5. Open it

Railway gives you a public URL like `https://vchat-production-xxxx.up.railway.app`.
Open it, pick your country, enter a phone number, and the 6-digit code appears on
the next screen (because `SMS_DEV_CODE=true`). Create your account and start chatting.

Try it from two devices/browsers with two different numbers to see messages arrive
live.

## 6. Later, when you have money — turn on real SMS (nothing to rebuild)

1. Create a (funded) Twilio project, get an SMS-capable sender, and set:
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`
2. Remove (or set to `false`) `SMS_DEV_CODE`.
3. Redeploy. Codes now go out as real SMS.

Optional add-ons, all can be added later the same way:
- **TURN relay** (`TURN_URLS` + `TURN_SECRET`) — for calls behind strict networks.
- **Passkeys** (`PASSKEY_ORIGIN` + `PASSKEY_RP_ID`) — set both to your Railway domain.
- **Paid story boosts** (`ENABLE_PAID_STORY_BOOSTS`, `VALMONTPAY_SECRET_KEY`, …).

## 7. Backup / restore

On Railway the volume at `/var/lib/vchat` is your live state. To snapshot it:

```bash
railway run --service vchat node scripts/backup-local.js
```

For a full local backup, copy `/var/lib/vchat/db.v2.json` and `/var/lib/vchat/media`
off the volume (`railway volume` commands or the in-browser file viewer).

## $0 alternative (your own computer + a tunnel)

If you'd rather not pay at all, you can run the same thing at home and expose it
with a free tunnel. Your computer must stay switched on and online:

```bash
npm install
npm start
```

then in a second terminal run a tunnel (e.g. Cloudflare Tunnel, `ngrok`, or
`localhost.run`) pointed at port 3000. Set the same environment variables as above
and give the app the tunnel's HTTPS address for `PUBLIC_APP_URL`/`PASSKEY_ORIGIN`
when you enable those features.

## Notes

- **Keep it single-node.** `ALLOW_TRANSITIONAL_LOCAL_STORAGE=true` uses a local
  JSON store; it is correct for one instance. Don't scale to 2+ instances until the
  database/object-storage phase replaces it (see `docs/operations.md`).
- **The on-screen code is for a trusted group.** Anyone who knows a phone number can
  read its code from the screen. Switch to Twilio before opening the app to the
  public.
- Calls work browser-to-browser over free STUN for most home/office networks.
