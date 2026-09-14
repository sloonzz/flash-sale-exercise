import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// The performance suite targets the same isolated database and Redis logical DB
// as the e2e suite (see .env.e2e) so a load run never reads or overwrites
// the dev environment's data.
const e2eEnv = parse(fs.readFileSync(path.resolve(dirname, '.env.e2e')));

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.performance-spec.ts'],
    env: e2eEnv,
    // Generous: a run where every request succeeds waits for its whole
    // backlog to persist, sized by settlePoll() in support/performance-harness.ts
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
