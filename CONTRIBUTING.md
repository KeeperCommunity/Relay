# Contributing

Use Node 22 and Yarn 1 with the committed lockfile. Run the local backend in `compose.local.yaml` or with a disposable MongoDB as described in [README.md](README.md). Keep tests and examples self-contained; do not depend on Keeper production accounts, buckets, FCM projects, or credentials.

Before opening a pull request, run `yarn test --runInBand` and the current-source scan in `scripts/check-source-secrets.py` using Gitleaks 8.30.1. Do not commit `.env`, service-account JSON, private keys, request bodies, user data, or screenshots from real users. Synthetic fixtures must be clearly disposable.

Keep changes to wallet signing, recovery and server-key behavior in their separately reviewed work. Provider integration changes should state which runtime identity, project and permission they need and how an unavailable provider fails. Never make an optional provider credential a condition for starting the local backend.

Report security issues privately through [SECURITY.md](SECURITY.md).
