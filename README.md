# Bitcoin Keeper Relay

Relay is the database, notification and integration backend used by [Bitcoin Keeper](https://github.com/KeeperCommunity/bitcoin-keeper). The mobile app also uses the public [Signing Server](https://github.com/KeeperCommunity/SigningServer).

## Local backend without hosted credentials

Use Docker Engine and Compose. The local stack has a disposable MongoDB and binds Relay only to loopback. Local mode blocks hosted integration routes.

From a checkout of this clean source:

```sh
docker compose -f compose.local.yaml up --build -d
curl --fail http://127.0.0.1:3000/health
```

The health response reports `ready: true`, `mode: local`, and the capabilities available in this stack. Relay HTTP and Socket.IO are on `127.0.0.1:3000` and `127.0.0.1:4002`. The local database has a named volume; `docker compose -f compose.local.yaml down` keeps it. This stack does not send push notifications, sign Apple offers, use the testnet faucet, upload screenshots, or contact hosted purchase and AI services. Unsupported integration routes return `503`.

For a host Node setup, use Node 22, Python 3, Yarn 1 and a **disposable local** MongoDB. Copy `.env.example` to an ignored `.env`, set `LOCAL_DEV=true`, `ENVIRONMENT=DEVELOPMENT`, `BITCOIN_NETWORK=TESTNET`, and a local `DATABASE_URL`, then run `yarn install --frozen-lockfile --ignore-scripts`, `yarn compile`, and `yarn start`. Never copy a hosted environment file into this checkout. Local mode refuses mainnet, non-development environments and nonlocal MongoDB hosts.

For app development, configure the mobile app to use these loopback Relay and channel URLs (Android emulator host routing may require `adb reverse`). The optional setup below also starts a local testnet Signing Server. Supported local Relay flows require no production provider credentials.

## Pair with the public Signing Server

Use Docker Compose 2.24.4 or newer for this optional stack. The public Signing Server supports installation, compilation and unit tests on its own. Its local Docker adapter is published in [app PR #7014](https://github.com/KeeperCommunity/bitcoin-keeper/pull/7014), which is still under review. The following commands pin the public adapter and the public Signing Server revision it supports. They do not fetch the older private Relay pin from that app setup.

From inside this Relay checkout:

```sh
RELAY_SOURCE_DIR="$PWD"
git clone --filter=blob:none --sparse --branch codex/contributor-dev-environment https://github.com/KeeperCommunity/bitcoin-keeper.git ../keeper-public-local-adapter
cd ../keeper-public-local-adapter
git sparse-checkout set dev/local-backend
git checkout 9878d64e8f363970f686852caeb94df540d3e81a
./dev/local-backend/dev prepare-signing
export SIGNING_SOURCE_DIR="$PWD/dev/local-backend/.sources/signing"
cd "$RELAY_SOURCE_DIR"
docker compose -f compose.local.yaml -f compose.local-with-signing.yaml up --build -d --wait
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:3003/health
```

This prepares Signing Server revision `b82dc4f4a8f75676b70b12545d59c7906556a92b`, verifies the adapter checksums, and starts the services behind a loopback gateway on ports 3000, 4002 and 3003. Relay, Mongo and Signing Server share an internal network with no external egress; only the gateway has host access. Signing Server creates independent disposable development identities in its named volume; preserve that volume together with Mongo when reusing local records. Do not export its contents. Local push delivery and scheduled jobs are disabled; email is captured inside the local signing volume and is never delivered.

Stop this stack with `docker compose -f compose.local.yaml -f compose.local-with-signing.yaml down`. This retains the Mongo and signing volumes. The pairing verifies local service availability; bitcoin signing, recovery, inheritance and timer-dependent behavior need their own separate checks. The app's full bootstrap will need its Relay source pin updated after this clean candidate is published.

The paired setup was checked on October 6, 2026 with the public revisions above: both health endpoints, synthetic Relay record create/read/update/clear, Socket.IO polling and WebSocket connections, and rejection of an unauthenticated Signing Server setup request passed. These checks used isolated local ports and disposable volumes.

## Hosted integrations

Configuration names are listed in `.env.example`; blank values are not credentials. Integrations are opt-in:

- `FIREBASE_PROJECT_ID` selects the FCM **target project**. On Google Cloud, the Firebase Admin SDK uses the VM's attached identity through Application Default Credentials. Give that identity only the FCM permission it needs in the target project. `FIREBASE_SERVICE_ACCOUNT_JSON` is a temporary, explicit fallback for a protected runtime secret outside Git; an invalid value fails closed. Local mode disables push delivery.
- `APPSTORE_KEY` and `APPSTORE_KEY_ID` are an optional pair for `/offer`. If both are absent, Relay starts and `/offer` returns `503`. These are distinct from `APPLE_SHARED_SECRET`, which validates purchase receipts.
- Screenshot uploads use Application Default Credentials and the `keeper-ai-chat` bucket. Relay does not need or ship the Tribe storage key. Grant a deployment identity bucket-scoped object creation only when this route is enabled and verified.
- Purchase, Ramp, Ask Keeper, faucet and other provider features need their own runtime configuration. Local mode keeps them unavailable.

Deployment and provider permissions are maintainer responsibilities. Do not use production credentials in a fork or issue report.

## Checks and contribution

Run `yarn test --runInBand` (which compiles first) and `python3 scripts/check-source-secrets.py` with Gitleaks 8.30.1. The database tests use `READINESS_MONGO_URL` pointing at a disposable MongoDB. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

Relay is licensed under the [MIT License](LICENSE). Dependencies retain their respective licenses.
