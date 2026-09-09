# Flash Sale

See [CONTEXT.md](./CONTEXT.md) for domain vocabulary and [docs/adr](./docs/adr) for architectural decisions.

## Layout

This is a Yarn workspaces monorepo:

- `/server` — Nest.js API (TypeScript), Prisma against Postgres.
- `/frontend` — React app (TypeScript), Vite.
- `docker-compose.yml` — Redis and Postgres only. The server and frontend are **not** dockerized; they run locally against this infra.

## Dev loop

1. Start the infra:

   ```sh
   docker compose up -d
   ```

2. Install dependencies once, from the repo root:

   ```sh
   yarn install
   cp server/.env.example server/.env
   yarn workspace server prisma migrate dev # first time only, applies the schema to Postgres
   ```

3. Run both the API and frontend together:

   ```sh
   yarn dev
   ```

   Or run just one, from the repo root: `yarn workspace server run dev` / `yarn workspace frontend run dev`.
