// Defaults match server/.env.example, which targets the docker-compose infra.
// Set the corresponding environment variable to override any of these.
export const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://flash_sale:flash_sale@localhost:5432/flash_sale?schema=public';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Bounds how long a Redis command waits for a reply. Without it, a network
// partition doesn't fail a purchase request — ioredis's offline queue holds
// the command open indefinitely while disconnected, so the request just
// hangs instead of erroring.
export const REDIS_COMMAND_TIMEOUT_MS = Number(
  process.env.REDIS_COMMAND_TIMEOUT_MS ?? 3000,
);
