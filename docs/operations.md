# Vchat pilot operations

This is the single-node pilot. Message text and media are still readable by the
server. Treat the host as trusted, encrypt the disk, and do not advertise the
deployment as end-to-end encrypted.

## What this layout is for

`compose.pilot.yml` runs one Node process with a persistent volume for
`data/db.v2.json` and `data/media`. It is enough to try Vchat on a VPS behind
HTTPS. It is **not** a multi-instance production cluster: OTP codes, sessions,
and the store are process-local. Adding a second replica without Redis and
shared object storage will drop codes, split conversations, and orphan media.

## Bring a pilot up

1. Provision a host with Docker, 2+ GB RAM, and an encrypted volume.
2. Point a DNS name at the host and terminate TLS on a reverse proxy (Caddy,
   nginx, or a managed load balancer). Forward HTTP and WebSocket traffic to
   `127.0.0.1:3000`.
3. Copy `.env.production.example` to `.env` on the host. Fill secrets from a
   secret manager — never from git.
4. Set at least:

   ```bash
   NODE_ENV=production
   TRUST_PROXY=1
   PUBLIC_APP_URL=https://chat.example.com
   TWILIO_ACCOUNT_SID=...
   TWILIO_AUTH_TOKEN=...
   TWILIO_FROM=+...
   PASSKEY_ORIGIN=https://chat.example.com
   PASSKEY_RP_ID=chat.example.com
   ```

5. Start the process:

   ```bash
   docker compose -f compose.pilot.yml up --build -d
   curl -fsS https://chat.example.com/healthz
   ```

6. Request a code to a real E.164 number and confirm it arrives in Twilio's
   logs. In production the development code is never returned or printed.

## Reverse proxy

The application must see a single trusted hop. Set `TRUST_PROXY=1` when one
proxy sits in front; do not enable `trust proxy` blindly or clients can spoof
rate-limit identity.

The proxy must:

- Serve only HTTPS and redirect HTTP
- Forward `Host`, `X-Forwarded-For`, `X-Forwarded-Proto`
- Allow WebSocket upgrades on the same origin (`/socket.io`)
- Not buffer Socket.IO or ValmontPay webhook bodies
- Pass `/api/story-ads/valmontpay/webhook` through unmodified so HMAC-SHA256
  covers the exact raw bytes

Session cookies are `HttpOnly`, `SameSite=Strict`, and `__Host-` in secure
mode. They will not be issued over plain HTTP.

## Secrets

Keep these only on the server:

| Secret | Used for |
| --- | --- |
| `TWILIO_AUTH_TOKEN` | SMS verification |
| `VALMONTPAY_SECRET_KEY` | Checkout, verify, webhook signatures |
| `TURN_SECRET` | Temporary TURN credentials |
| Volume contents under `/var/lib/vchat` | Account snapshots and media |

Rotate Twilio and ValmontPay keys in the provider console, then replace `.env`
and recreate the container. Changing `PASSKEY_RP_ID` invalidates enrolled
chat-lock passkeys.

## Backups

The transitional store writes `db.v2.json` (mode `0600`) and media files under
`VCHAT_DATA_DIR`. Snapshot the Docker volume at least daily:

```bash
docker compose -f compose.pilot.yml stop vchat
docker run --rm -v vchat-data:/data -v "$PWD/backups:/out" alpine \
  tar czf /out/vchat-$(date +%F).tgz -C /data .
docker compose -f compose.pilot.yml start vchat
```

Store backups encrypted and off-host. Schema v2 never imports legacy
`data/db.json`; restoring the wrong file starts a clean database.

## Health and logs

- `GET /healthz` — liveness (`{ ok, service: "vchat" }`)
- `GET /api/health` — process uptime (authenticated routes are separate)
- Container logs are JSON, rotated at 10 MB × 5 files

A 503 on `POST /api/auth/request-code` in production means Twilio is missing
or incomplete. A 401 on the ValmontPay webhook means the signature or raw body
was altered in transit.

## Advertiser pilot

Leave `VALMONTPAY_SECRET_KEY` and `STORY_AD_ADMIN_PHONES` empty until policy,
support, and refund procedures exist. When enabling paid delivery:

1. Register `https://<host>/api/story-ads/valmontpay/webhook` at ValmontPay
2. Confirm the tenant signs with HMAC-SHA256 over the raw body
3. Restrict `STORY_AD_ADMIN_PHONES` to named operators
4. Keep `PUBLIC_APP_URL` on HTTPS — checkout initialization refuses anything else

Stopping a campaign does not issue a refund.

## Scaling stop-line

Do not put this compose file behind a load balancer with more than one app
replica. Horizontal scale needs PostgreSQL, Redis (OTP, sessions, Socket.IO
adapter), object storage for media, and a TURN/SFU path for calls. Those belong
to the infrastructure phase described in the README.
