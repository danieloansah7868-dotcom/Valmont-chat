# Vchat operations runbook

## Release classification

The repository currently contains a **transitional single-node JSON and local-media adapter**. Production mode rejects this adapter by default. `ALLOW_TRANSITIONAL_LOCAL_STORAGE=true` is a conspicuous, audited override for a controlled pilot with exactly one process and one durable volume; it does not turn that adapter into production-grade persistence.

Do not use the override for public paid workloads, multiple replicas, or WhatsApp-like confidentiality claims. PostgreSQL/Redis/object-storage adapters and reviewed multi-device end-to-end encryption are still release blockers.

## Build and release

The image is built from the lockfile and an exact Node runtime:

```sh
npm ci --ignore-scripts
npm run ci
docker build --pull -t vchat:$GIT_SHA .
```

For a controlled single-node pilot, copy `.env.production.example` to an untracked
`.env.production`, replace every placeholder through the deployment secret manager,
validate it, and use `docker compose -f compose.pilot.yml up -d`. The reference
compose file drops Linux capabilities, uses a read-only root filesystem, publishes
only to host loopback for a local TLS proxy, persists `/var/lib/vchat`, and fixes the
replica count at one. Replace its local image tag with the immutable release digest
in a managed environment.

CI repeats syntax checks, integration tests, dependency audit, and image build. Deploy by immutable image digest, not a mutable tag. Never bake an `.env` file or credentials into an image.

Before any production-mode start, create secrets in the deployment platform and validate the effective environment:

```sh
NODE_ENV=production npm run check:env
```

`.env.production.example` lists supported settings. The validator requires a canonical HTTPS origin, aligned WebAuthn RP settings, explicit proxy trust, Twilio SMS, TURN, and an explicit persistence decision. Enabling paid Status boosts additionally requires ValmontPay and an advertising-administrator phone allowlist. Validation runs before the local store module is imported.

### Controlled-pilot topology

If the transitional override has been risk-accepted:

- run exactly one application process (`WEB_CONCURRENCY=1`);
- mount one durable, encrypted-at-rest volume at `VCHAT_DATA_DIR`;
- keep `VCHAT_MEDIA_DIR` on that same protected operational boundary;
- terminate TLS at a reverse proxy and preserve WebSocket upgrades;
- never expose the application container directly to the internet;
- restrict volume and backup access to the service identity and recovery operators;
- configure a restart policy, but never overlap old and new writers during rollout.

A rolling deployment is unsafe for this adapter. Stop the old process, take a verified backup, and only then start the replacement.

## Health, metrics, and logs

| Endpoint | Meaning | Exposure |
| --- | --- | --- |
| `GET /livez` | Event loop can answer HTTP | Orchestrator only |
| `GET /readyz` | Process accepts traffic; persistence paths are readable/writable and have at least `READINESS_MIN_FREE_MB` free | Orchestrator only |
| `GET /healthz` | Compatibility alias for readiness | Orchestrator only |
| `GET /metrics` | Bounded Prometheus counters; 404 when disabled | Private monitoring network |

`/metrics` requires `Authorization: Bearer $METRICS_TOKEN`. Do not place that token in a URL. Rotate it like any other operational secret.

Logs are one-line JSON. Production request logs contain request ID, method, route, status, and duration, but not cookies, authorization headers, message bodies, phone numbers, or media paths. Forward stdout/stderr to access-controlled centralized storage with retention and alerting. At minimum alert on:

- `runtime_configuration_rejected` or any `fatal` record;
- sustained readiness failures;
- elevated `vchat_http_errors_total` rate;
- elevated `vchat_rate_limited_total` rate;
- abnormal restarts or graceful-shutdown timeouts;
- Twilio, TURN, or ValmontPay provider errors.

Every response includes `X-Request-ID`; provide that identifier, not user content, in incident tickets.

## Graceful shutdown

`SIGTERM` and `SIGINT` immediately fail readiness, stop accepting Socket.IO work, close idle HTTP connections, and wait up to `SHUTDOWN_TIMEOUT_MS` (default 10 seconds). The orchestrator termination grace period must exceed this value by at least five seconds.

Because calls and OTP continuation state remain process-local, a restart interrupts them. Drain planned changes during a low-traffic window and communicate this limitation to pilot users.

## Offline backup procedure (transitional adapter only)

The backup tool deliberately requires `--confirm-offline`. Copying the JSON snapshot while the process is writing can produce a logically inconsistent backup.

1. Put the service in maintenance mode and stop the application process. Confirm no other process or replica has the volume mounted read/write.
2. Create a new backup directory outside `VCHAT_DATA_DIR`:

   ```sh
   npm run backup:local -- --confirm-offline /var/lib/vchat /secure-staging/vchat-$(date -u +%Y%m%dT%H%M%SZ)
   ```

3. Require a successful JSON result. The backup contains schema-v2 state, protected media bytes, and a SHA-256 manifest. It refuses symlinks and an existing destination.
4. Encrypt the complete backup directory with the organization-approved backup system, transfer it to off-host immutable storage, and remove the staging copy according to policy.
5. Record the source release SHA/image digest, backup object version, operator, and manifest digest in the change ticket. Never paste the manifest or database into chat or tickets; both are sensitive.
6. Start the same release and verify `/readyz`, login, authorized media retrieval, and a realtime message before ending maintenance.

Suggested controlled-pilot objective: daily backups with RPO 24 hours and tested RTO 4 hours. This is not an SLA. Set actual objectives through a risk review before onboarding users.

## Restore and disaster-recovery drill

Always restore into a **new, empty destination**. The tool verifies the manifest, every byte count and SHA-256 digest, safe paths, and schema version before atomically renaming the recovered directory. It never overwrites live data.

```sh
npm run restore:local -- --confirm-offline /secure-staging/verified-backup /var/lib/vchat-restored
VCHAT_DATA_DIR=/var/lib/vchat-restored NODE_ENV=production npm run check:env
```

Then start the exact image recorded with the backup against the restored path, verify readiness and the smoke checks above, stop it, and perform the approved volume swap. Retain the old volume read-only until the recovery owner signs off.

Run a restore drill at least quarterly and after changing schema or backup tooling. Record measured RPO/RTO and any missing media. The automated test suite includes a backup/restore round trip and proves tampered bytes do not leave a partial destination; it does not replace an off-host infrastructure drill.

## Incident actions

1. **Suspected credential or session leak:** revoke sessions, rotate affected provider/metrics secrets, preserve access-controlled logs, and notify the incident owner.
2. **Data-integrity concern:** fail readiness, stop the sole writer, snapshot the volume at the infrastructure layer, and restore only from a manifest-verified backup.
3. **ValmontPay discrepancy:** pause campaign review/delivery, retain reference IDs, reconcile server-side verification/webhook records, and never mark payment from a browser callback.
4. **Abuse spike:** inspect aggregate rate-limit/error metrics, tighten edge controls, and avoid logging message or profile content during investigation.
5. **Privacy incident:** treat JSON state, media, and backups as sensitive user data. Follow applicable notification and deletion procedures.

## Exit criteria for the transitional override

Remove `ALLOW_TRANSITIONAL_LOCAL_STORAGE` and do not launch public production until all of the following exist and have failure-mode tests:

- transactional PostgreSQL persistence and migrations;
- private object storage with authorization-aware deletion and lifecycle reconciliation;
- Redis-backed OTP/continuation, rate-limit, relock, presence, and Socket.IO coordination;
- multi-replica readiness and fan-out testing;
- provider sandbox/canary validation for Twilio, ValmontPay, TURN, and the chosen SFU;
- audited multi-device E2EE, encrypted media, identity verification, and encrypted recovery;
- provider-native backup/restore automation with point-in-time recovery drills.
