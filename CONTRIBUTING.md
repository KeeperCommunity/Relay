# Contributing

Use Node 22 and Yarn 1 with the committed lockfile. Run the local backend in `compose.local.yaml` or with a disposable MongoDB as described in [README.md](README.md). Keep tests and examples self-contained; do not depend on Keeper production accounts, buckets, FCM projects, or credentials.

Before opening a pull request, run `yarn test --runInBand`, `yarn test:backup` against the disposable `keeperQA` replica set (see README) and the current-source scan in `scripts/check-source-secrets.py` using Gitleaks 8.30.1. Do not commit `.env`, service-account JSON, private keys, request bodies, user data, or screenshots from real users. Synthetic fixtures must be clearly disposable.

Run `yarn audit --groups dependencies` for runtime dependencies; CI requires this check to pass. On 6 October 2026 the committed lockfile had no reported runtime advisories. A full audit also includes two unpatched denial-of-service advisories in Jest's development dependencies: [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) and [sprintf-js](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). Their inputs here are checked-in test patterns and tool configuration, not HTTP requests. Run contribution tests in a disposable environment without hosted credentials; CI has a 15-minute job limit. These warnings are recorded, not suppressed, and should be reviewed when updating test tools.

Keep changes to wallet signing, recovery and server-key behavior in their separately reviewed work. Provider integration changes should state which runtime identity, project and permission they need and how an unavailable provider fails. Never make an optional provider credential a condition for starting the local backend.

Report security issues privately through [SECURITY.md](SECURITY.md).
