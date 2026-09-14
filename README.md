# Flash Sale

See [CONTEXT.md](./CONTEXT.md) for domain vocabulary and [docs/adr](./docs/adr) for architectural decisions.

## Layout

This is a Yarn workspaces monorepo:

- `/server` — Nest.js API (TypeScript), Prisma against Postgres.
- `/frontend` — React app (TypeScript), Vite.
- `docker-compose.yml` — Redis and Postgres only. The server and frontend are **not** dockerized; they run locally against this infra.

## Running the app

1. Install dependencies once, from the repo root:

   ```sh
   yarn
   ```

2. Build the shared `common` package and generate the Prisma client. Both are gitignored build outputs, so this is needed before `common` will resolve or the server will typecheck/run:

   ```sh
   yarn generate
   ```

3. Run the app. This starts the Docker infra (Postgres and Redis) and the API and frontend together:

   ```sh
   yarn dev
   ```

   Or run just one, from the repo root: `yarn workspace server run dev` / `yarn workspace frontend run dev`.

4. Apply database migrations (first time, and whenever the schema changes):

   ```sh
   yarn migrate:db
   ```

5. Copy env file:

   ```sh
   cp server/.env.example server/.env
   ```

## User flow

With the app running (`yarn dev`), a typical walkthrough:

1. Go to `/admin` and log in with the admin key (`change-me` by default, from `server/.env.example`'s `ADMIN_KEY`).
2. Fill up and create a sale using the admin sale form.
3. Go back to `/` (the "Sale" nav link) and enter a user name.
4. Attempt a purchase.

## Running tests

There are five kinds of server tests, from fastest/narrowest to slowest/broadest:

- **Unit** (`*.spec.ts`) — no external infra required.
- **Integration** (`*.integration.spec.ts`) — hit real Redis/Postgres/BullMQ directly (no HTTP layer). Requires `yarn dev`'s Docker infra running against your normal dev `DATABASE_URL`/`REDIS_URL`.
- **E2E** (`*.e2e-spec.ts`) — spin up the Nest app in-process and exercise it over HTTP with supertest.
- **Performance** (`*.performance-spec.ts`) — load-test the real app under `autocannon`/concurrent load, either against real Redis directly (`redis-reserve.performance-spec.ts`) or against a clustered server process (`purchase.performance-spec.ts`, `sale-status.performance-spec.ts`). Each HTTP suite runs under two load profiles: a short **spike** of many connections and a longer **stress** run with fewer connections.
- **Fault tolerance** (`*.fault-spec.ts`) — boot the real app and then break its infra out from under it via the Docker CLI: stopping Postgres mid-purchase (write retry), wiping Redis (stock reconciliation from Postgres), network-partitioning Redis (command timeouts), restarting the app with a BullMQ backlog still failing against a dead Postgres (exactly-once drain), and a persist-order enqueue that fails after the Reservation landed (re-enqueued by startup reconciliation). Each suite checks the app recovers with no lost or duplicated orders. Requires `docker` on your PATH; the suites run one file at a time since they take down the shared containers.

E2E, performance and fault-tolerance tests run against an isolated database/Redis logical DB (see `server/.env.e2e`) rather than your dev environment, so they never read or clobber dev data. That database only exists if you're on a fresh Postgres volume (created by `docker/postgres-init/01-create-e2e-db.sql`) or you migrate it yourself:

```sh
yarn workspace server run migrate:e2e-db
```

Then, from the repo root:

```sh
yarn test:unit         # unit tests

# Everything below needs the yarn dev's infra (DB and Redis) running
yarn test:integration  # integration tests
yarn test:e2e          # e2e tests (needs the e2e db migrated, see above)
yarn test:performance  # performance tests (same isolated db/redis as e2e)
yarn test:fault-tolerance  # fault-tolerance tests (same isolated db/redis; stops/partitions the Docker containers)
```

Performance tests default to a 4-worker clustered server and can be tuned via env vars under `.env.e2e.` see the `test/support/config.ts` file for more details.
