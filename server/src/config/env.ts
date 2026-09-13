// Defaults match server/.env.example, which targets the docker-compose infra.
// Set the corresponding environment variable to override any of these.
export const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://flash_sale:flash_sale@localhost:5432/flash_sale?schema=public';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export const THROTTLE_LIMIT = Number(process.env.THROTTLE_LIMIT ?? 20);
