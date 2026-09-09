# Flash Sale

See [CONTEXT.md](./CONTEXT.md) for domain vocabulary and [docs/adr](./docs/adr) for architectural decisions.

## Layout

- `/server` — Nest.js API (TypeScript), Prisma against Postgres.
- `/frontend` — React app (TypeScript), Vite.
- `docker-compose.yml` — Redis and Postgres only. The server and frontend are **not** dockerized; they run locally against this infra.

## Dev loop

1. Start the infra:

   ```sh
   docker compose up -d
   ```

2. In one terminal, run the API:

   ```sh
   cd server
   cp .env.example .env # first time only
   npm install           # first time only
   npx prisma migrate dev # first time only, applies the schema to Postgres
   npm run dev
   ```

3. In another terminal, run the frontend:

   ```sh
   cd frontend
   npm install # first time only
   npm run dev
   ```
