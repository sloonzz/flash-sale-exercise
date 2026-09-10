import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Integration specs hit real Redis/Postgres/BullMQ and run separately
    // via `yarn test:integration` (see vitest.config.integration.ts) so the
    // default unit run never touches real infra.
    exclude: ['**/node_modules/**', '**/*.integration.spec.ts'],
  },
});
