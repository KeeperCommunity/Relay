# Bitcoin Keeper Relay

Relay is the database, notification and integration backend used by [Bitcoin Keeper](https://github.com/KeeperCommunity/bitcoin-keeper). The mobile app also uses the public [Signing Server](https://github.com/KeeperCommunity/SigningServer).

## Local backend without hosted credentials

Use Docker Engine and Compose. The local stack has a disposable single-member MongoDB replica set (`keeper-local`) and binds Relay only to loopback. Backup snapshot and repair use transactions, so a standalone MongoDB cannot serve those routes. Local mode blocks hosted integration routes.

From a checkout of this clean source:

```sh
docker compose -f compose.local.yaml up --build -d
curl --fail http://127.0.0.1:3000/health
```

The health response reports `ready: true`, `mode: local`, and the capabilities available in this stack. Relay HTTP and Socket.IO are on `127.0.0.1:3000` and `127.0.0.1:4002`. The local database has a named volume; `docker compose -f compose.local.yaml down` keeps it. This stack does not send push notifications, sign Apple offers, use the testnet faucet, upload screenshots, or contact hosted purchase and AI services. Unsupported integration routes return `503`.

For a host Node setup, use Node 22, Python 3, Yarn 1 and a **disposable local single-member replica set** of MongoDB. Copy `.env.example` to an ignored `.env`, set `LOCAL_DEV=true`, `ENVIRONMENT=DEVELOPMENT`, `BITCOIN_NETWORK=TESTNET`, and a local `DATABASE_URL` with the replica-set name in `?replicaSet=...`, then run `yarn install --frozen-lockfile --ignore-scripts`, `yarn compile`, and `yarn start`. Never copy a hosted environment file into this checkout. Local mode refuses mainnet, non-development environments and nonlocal MongoDB hosts.

For app development, configure the mobile app to use these loopback Relay and channel URLs (Android emulator host routing may require `adb reverse`). The optional setup below also starts a local testnet Signing Server. Supported local Relay flows require no production provider credentials.

## Pair with the public Signing Server

Use Docker Compose 2.24.4 or newer for this optional stack. The public Signing Server supports installation, compilation and unit tests on its own. Its local Docker adapter is published in [app PR #7030](https://github.com/KeeperCommunity/bitcoin-keeper/pull/7030), which is still under review. The following commands pin that public adapter and the public Signing Server revision it supports. The app PR's full bootstrap now also pins this public Relay source.

From inside this Relay checkout:

```sh
RELAY_SOURCE_DIR="$PWD"
git clone --filter=blob:none --sparse --branch codex/r3-public-contributor-sprint https://github.com/KeeperCommunity/bitcoin-keeper.git ../keeper-public-local-adapter
cd ../keeper-public-local-adapter
git sparse-checkout set dev/local-backend
git checkout 19e079ae4486dacf1f79bf5e527384e608872977
./dev/local-backend/dev prepare-signing
export SIGNING_SOURCE_DIR="$PWD/dev/local-backend/.sources/signing"
cd "$RELAY_SOURCE_DIR"
docker compose -f compose.local.yaml -f compose.local-with-signing.yaml up --build -d --wait
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:3003/health
```

This prepares Signing Server revision `3cc7728c27328e7b0358d1f91a32d8d13feba90a`, verifies the adapter checksums, and starts the services behind a loopback gateway on ports 3000, 4002 and 3003. Relay, Mongo and Signing Server share an internal network with no external egress; only the gateway has host access. Signing Server creates independent disposable development identities in its named volume; preserve that volume together with Mongo when reusing local records. Do not export its contents. Local push delivery and scheduled jobs are disabled; email is captured inside the local signing volume and is never delivered.

Stop this stack with `docker compose -f compose.local.yaml -f compose.local-with-signing.yaml down`. This retains the Mongo and signing volumes. The pairing verifies local service availability; bitcoin signing, recovery, inheritance and timer-dependent behavior need their own separate checks. For the complete app contributor stack, use the current public contributor PR #7030 and run `./dev/local-backend/dev up` from that app checkout. That app revision pins Relay `4c54e28738815546718775dbbdb39f0342c1b646`, which includes the backup snapshot and repair protocol plus its revision guards.

The earlier public-source paired setup was checked on October 6, 2026 with isolated local ports and disposable volumes: both health endpoints, synthetic Relay record create/read/update/clear, Socket.IO polling and WebSocket connections, and rejection of an unauthenticated Signing Server setup request passed. The app contributor CI verifies its pinned stack from public sources and also exercises backup snapshot/repair, stale revisions, content changing from A to B and back to A, and persistence across service restarts. Check the linked app PR for results at the pinned revision; the earlier setup check does not attest to a newer stack.

## Backup snapshot and repair

`POST /getBackupSnapshot` reads an account's encrypted recovery records in one database snapshot and returns a SHA-256 `revision` covering encrypted content plus a retained account mutation generation, the app image, account-scoped vault images, labels, and any unavailable vault IDs. It does not replace the backup. Invalid account identifiers return `400`; unavailable storage returns a fixed `503` response.

`POST /repairAppBackup` requires the revision just read. A stale revision returns `409` with `BACKUP_CHANGED`; the existing backup stays intact. The generation advances transactionally on backup mutations and survives Delete Backup, so returning from content A to B and back to A never reuses an earlier token. Explicit current-state replacement must use the existing app verification/resubmission flow. Legacy full replacements cannot bypass this requirement after a revisioned repair. Collaborative accounts retain independently encrypted vault copies; no other account's ciphertext is substituted for a missing copy.

The source includes the guarded backup implementation used by the mobile recovery protocol. Publishing it does not deploy a backend or migrate a hosted database. Before any hosted adoption, maintainers must review transaction/replica-set support and the account-scoped unique index with staging fixtures.

## Hosted integrations

Configuration names are listed in `.env.example`; blank values are not credentials. Integrations are opt-in:

- `FIREBASE_PROJECT_ID` selects the FCM **target project**. On Google Cloud, the Firebase Admin SDK uses the VM's attached identity through Application Default Credentials. Give that identity only the FCM permission it needs in the target project. `FIREBASE_SERVICE_ACCOUNT_JSON` is a temporary, explicit fallback for a protected runtime secret outside Git; an invalid value fails closed. Local mode disables push delivery.
- `APPSTORE_KEY` and `APPSTORE_KEY_ID` are an optional pair for `/offer`. If both are absent, Relay starts and `/offer` returns `503`. These are distinct from `APPLE_SHARED_SECRET`, which validates purchase receipts.
- Screenshot uploads use Application Default Credentials and the `keeper-ai-chat` bucket. Relay does not need or ship the Tribe storage key. Grant a deployment identity bucket-scoped object creation only when this route is enabled and verified.
- Purchase, Ramp, Ask Keeper, faucet and other provider features need their own runtime configuration. Local mode keeps them unavailable.

Deployment and provider permissions are maintainer responsibilities. Do not use production credentials in a fork or issue report.

## Checks and contribution

Run `yarn test --runInBand` (which compiles first) and `python3 scripts/check-source-secrets.py` with Gitleaks 8.30.1. The database tests use `READINESS_MONGO_URL` pointing at a disposable MongoDB. Run `yarn test:backup` with a disposable loopback replica set named `keeperQA` (default `127.0.0.1:27028`, or set `BACKUP_TEST_MONGO_URL` to its loopback address). These tests create and drop only uniquely named test databases; they never read `.env` or hosted credentials. CI runs both suites. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

Relay is licensed under the [MIT License](LICENSE). Dependencies retain their respective licenses.
