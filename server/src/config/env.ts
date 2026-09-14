// Defaults match server/.env.example, which targets the docker-compose infra.
// Set the corresponding environment variable to override any of these.
export const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://flash_sale:flash_sale@localhost:5432/flash_sale?schema=public';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export const THROTTLE_LIMIT = Number(process.env.THROTTLE_LIMIT ?? 20);

export const THROTTLE_DISABLED = process.env.DISABLE_THROTTLE === 'true';
// Bounds how long a Redis command waits for a reply. Without it, a network
// partition doesn't fail a purchase request — ioredis's offline queue holds
// the command open indefinitely while disconnected, so the request just
// hangs instead of erroring.
export const REDIS_COMMAND_TIMEOUT_MS = Number(
  process.env.REDIS_COMMAND_TIMEOUT_MS ?? 3000,
);

// How many times a persist-order job is attempted before it is dead-lettered
// (left in BullMQ's `failed` set and alerted on). With the capped exponential
// backoff in persist-order-job.ts, 50 attempts ≈ 23 minutes of retrying.
export const PERSIST_ORDER_ATTEMPTS = Number(
  process.env.PERSIST_ORDER_ATTEMPTS ?? 50,
);

// How often each replica checks BullMQ's `failed` set for dead-lettered
// persist-order jobs and, if Postgres is reachable, retries them. A Redis
// lease keeps it to one sweep per interval across the whole fleet. 0 disables.
export const PERSIST_ORDER_DLQ_SWEEP_MS = Number(
  process.env.PERSIST_ORDER_DLQ_SWEEP_MS ?? 60_000,
);

// How far back startup reconciliation looks: every sale whose end time is
// within this window is reconciled, older ones are left alone. Bounds the
// startup cost as the sales table grows; anything still stranded on a sale
// older than this needs a manual reconcile.
export const RECONCILE_SALES_WINDOW_MS = Number(
  process.env.RECONCILE_SALES_WINDOW_MS ?? 7 * 24 * 60 * 60 * 1_000,
);
