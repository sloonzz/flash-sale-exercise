import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// The e2e suite targets its own database and Redis logical DB (see
// .env.e2e) so it never reads or overwrites the dev environment's data.
const e2eEnv = parse(fs.readFileSync(path.resolve(dirname, '.env.e2e')));

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    env: e2eEnv,
    globalSetup: ['./test/e2e-global-setup.ts'],
  },
});
