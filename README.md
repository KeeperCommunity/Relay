# Bitcoin Keeper Relay

Relay is the database, notification and integration backend used by [Bitcoin Keeper](https://github.com/KeeperCommunity/bitcoin-keeper). The mobile app also uses a separate Signing Server. Full wallet flows require that server's independently reviewed public source and local setup.

## Local backend without hosted credentials

Use Docker Engine and Compose. The local stack has a disposable MongoDB and binds Relay only to loopback. Local mode blocks hosted integration routes.

From a checkout of this clean source:

```sh
cd bitcoin-keeper-relay
docker compose -f compose.local.yaml up --build -d
curl --fail http://127.0.0.1:3000/health
```

The health response reports `ready: true`, `mode: local`, and the capabilities available in this stack. Relay HTTP and Socket.IO are on `127.0.0.1:3000` and `127.0.0.1:4002`. The local database has a named volume; `docker compose -f compose.local.yaml down` keeps it. This stack does not send push notifications, sign Apple offers, use the testnet faucet, upload screenshots, or contact hosted purchase and AI services. Unsupported integration routes return `503`.

For a host Node setup, use Node 22, Python 3, Yarn 1 and a **disposable local** MongoDB. Copy `.env.example` to an ignored `.env`, set `LOCAL_DEV=true`, `ENVIRONMENT=DEVELOPMENT`, `BITCOIN_NETWORK=TESTNET`, and a local `DATABASE_URL`, then run `yarn install --frozen-lockfile --ignore-scripts`, `yarn compile`, and `yarn start`. Never copy a hosted environment file into this checkout. Local mode refuses mainnet, non-development environments and nonlocal MongoDB hosts.

For app development, configure the mobile app to use these loopback Relay and channel URLs (Android emulator host routing may require `adb reverse`). Once the Signing Server's public local setup is available, start it using independent disposable test keys and verify signing and recovery flows separately. Until then, external developers can reproduce the supported local Relay flows without production provider credentials.

## Hosted integrations

Configuration names are listed in `.env.example`; blank values are not credentials. Integrations are opt-in:

- `FIREBASE_PROJECT_ID` selects the FCM **target project**. On Google Cloud, the Firebase Admin SDK uses the VM's attached identity through Application Default Credentials. Give that identity only the FCM permission it needs in the target project. `FIREBASE_SERVICE_ACCOUNT_JSON` is a temporary, explicit fallback for a protected runtime secret outside Git; an invalid value fails closed. Local mode disables push delivery.
- `APPSTORE_KEY` and `APPSTORE_KEY_ID` are an optional pair for `/offer`. If both are absent, Relay starts and `/offer` returns `503`. These are distinct from `APPLE_SHARED_SECRET`, which validates purchase receipts.
- Screenshot uploads use Application Default Credentials and the `keeper-ai-chat` bucket. Relay does not need or ship the Tribe storage key. Grant a deployment identity bucket-scoped object creation only when this route is enabled and verified.
- Purchase, Ramp, Ask Keeper, faucet and other provider features need their own runtime configuration. Local mode keeps them unavailable.

Deployment and provider permissions are maintainer responsibilities. Do not use production credentials in a fork or issue report.

## Checks and contribution

Run `yarn test --runInBand` (which compiles first) and `python3 scripts/check-source-secrets.py` with Gitleaks 8.30.1. The database tests use `READINESS_MONGO_URL` pointing at a disposable MongoDB. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
