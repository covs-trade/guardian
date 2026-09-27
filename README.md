# Cove Guardian

Private signing service for the Cove app. Deploy this repository as a separate service in the same Railway project as the app and PostgreSQL database. Do not assign a public domain to the service.

## Local regtest

Start local PostgreSQL on port 5432 and Bitcoin Core regtest RPC on port 18443 (`user`/`pass`). Then run `pnpm install` and `pnpm dev:regtest`. This builds the Rust executable and starts Guardian on port 4391 with the public regtest test key and bundled `regtest` TOML profile. Check it with `curl -H 'Authorization: Bearer local-dev' http://127.0.0.1:4391/health`.

The app uses its in-process signer on regtest, so this separate service is optional for normal local app testing. The health check exercises this service against local PostgreSQL and Bitcoin Core. The app uses the remote Guardian over HTTP on mainnet.

## Run

Use Node 20 or newer, pnpm 10.33.0, Rust, PostgreSQL, and Bitcoin Core RPC. On mainnet the committed ord endpoint is `https://ordinals.com`; signing requests with funding inputs fail closed if it is unavailable. Run `pnpm install`, `pnpm build:rust`, then `pnpm start`. Run `pnpm typecheck`, `pnpm lint`, and `pnpm test` to check the source. Apply the shared database migrations with `DATABASE_URL=<database-url> pnpm db:migrate` before starting the service.

For Railway, deploy the included Dockerfile. Set the variables in `.env.example` as Railway service variables. Set `COVE_DATABASE_URL` to the same PostgreSQL database used by the app and worker. Set `GUARDIAN_AUTH_TOKEN` to the same value the app uses as `COVE_GUARDIAN_AUTH_TOKEN`. Set `COVE_FEE_ADDRESS` to the same address as the app and worker. Keep `GUARDIAN_KEY_HEX` only in the Guardian service. Keep the recovery key offline. The app calls `http://<guardian-service>.railway.internal:4391` through Railway private networking.

The Guardian reads `packages/cove-mainnet/profiles.toml` at startup and selects `[networks.mainnet]` or `[networks.regtest]` from `COVE_NETWORK`. The `[protocol]` table is shared. Keep the same file in the app repository so both services calculate the same profile hash. Public profile settings live in TOML for local and production runs; env vars carry secrets and service endpoints. `envalid` checks the Guardian env before service construction, and invalid env or TOML stops startup. For mainnet, add the missing public fields under `[networks.mainnet]`, `[networks.mainnet.recovery]`, and `[networks.mainnet.canary]`; omitted TOML keys are the pending owner decisions. Mainnet startup stays blocked until the profile validates. Keep `COVE_V3_CANARY_ACTIVE=0` until the operator canary is ready; a public launch remains blocked by the funding-after-signing liveness issue.
