import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Targets the same dedicated e2e database and Redis logical DB as the e2e
// suite (see .env.e2e) — never the dev environment's data.
const e2eEnv = parse(fs.readFileSync(path.resolve(dirname, '.env.e2e')));

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/fault-tolerance/**/*.fault-spec.ts'],
    env: e2eEnv,
    globalSetup: ['./test/e2e-global-setup.ts'],
    // These tests stop/restart/network-partition the shared docker-compose
    // Postgres and Redis containers. Running them concurrently — with each
    // other or with anything else touching that infra — would have one
    // test's outage corrupt another's run, so force one file at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
