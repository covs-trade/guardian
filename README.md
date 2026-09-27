# Cove Guardian

Private signing service for the Cove app. Deploy this repository as a separate service in the same Railway project as the app and PostgreSQL database. Do not assign a public domain to the service.

## Run

Use Node 20 or newer, pnpm 10.33.0, Rust, PostgreSQL, Bitcoin Core RPC, and an ord endpoint. Run `pnpm install`, `pnpm build:rust`, then `pnpm start`. Run `pnpm typecheck`, `pnpm lint`, and `pnpm test` to check the source. Apply the shared database migrations with `DATABASE_URL=<database-url> pnpm db:migrate` before starting the service.

For Railway, deploy the included Dockerfile. Set the variables in `.env.example` as Railway service variables. Set `COVE_DATABASE_URL` to the same PostgreSQL database used by the app and worker. Set `GUARDIAN_AUTH_TOKEN` to the same value the app uses as `COVE_GUARDIAN_AUTH_TOKEN`. Set `COVE_FEE_ADDRESS` to the same address as the app and worker. Keep `GUARDIAN_KEY_HEX` only in the Guardian service. Keep the recovery key offline. The app calls `http://<guardian-service>.railway.internal:4391` through Railway private networking.

The Guardian and app must use the same committed mainnet profile and database schema. Mainnet profile placeholders must be filled before startup. Keep `COVE_V3_CANARY_ACTIVE=0` until the operator canary is ready; a public launch remains blocked by the funding-after-signing liveness issue.
