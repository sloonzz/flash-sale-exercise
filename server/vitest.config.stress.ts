import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// The stress suite targets the same isolated database and Redis logical DB
// as the e2e suite (see .env.e2e) so a load run never reads or overwrites
// the dev environment's data.
const e2eEnv = parse(fs.readFileSync(path.resolve(dirname, '.env.e2e')));

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.stress-spec.ts'],
    env: e2eEnv,
    // Deliberately no globalSetup here: unlike the e2e suite, this suite
    // does not TRUNCATE the shared tables / FLUSHDB Redis on start. Doing so
    // would race destructively with an e2e run against the same isolated
    // DB (whichever suite's setup runs second wipes state out from under
    // the other). Every assertion below already scopes reads to the exact
    // sale ID this run created, so a blanket wipe isn't needed for
    // correctness -- each test's own afterEach cleans up what it made.
    // A stress run fires hundreds of concurrent requests and waits for the
    // BullMQ consumer to drain the resulting order-persistence queue, which
    // takes well beyond vitest's default 5s test timeout.
    testTimeout: 120_000,
    // Runs are report-oriented (throughput/latency, oversell assertions) and
    // not meant to be parallelized against each other.
    fileParallelism: false,
  },
});
