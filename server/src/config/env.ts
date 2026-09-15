// Defaults match server/.env.example, which targets the docker-compose infra.
// Set the corresponding environment variable to override any of these.
export const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://flash_sale:flash_sale@localhost:5432/flash_sale?schema=public';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Where the rate limiter keeps its counters. Defaults to the main Redis so a
// single instance is enough; point it elsewhere in prod once Redis is the
// bottleneck, since sold-out traffic is nothing but throttle commands and
// the reserve script shouldn't compete with them.
export const THROTTLE_REDIS_URL = process.env.THROTTLE_REDIS_URL ?? REDIS_URL;

export const THROTTLE_LIMIT = Number(process.env.THROTTLE_LIMIT ?? 20);

export const THROTTLE_DISABLED = process.env.DISABLE_THROTTLE === 'true';
// Bounds how long a Redis command waits for a reply. Without it, a network
// partition doesn't fail a purchase request — ioredis's offline queue holds
// the command open indefinitely while disconnected, so the request just
// hangs instead of erroring.
export const REDIS_COMMAND_TIMEOUT_MS = Number(
  process.env.REDIS_COMMAND_TIMEOUT_MS ?? 3000,
);

// How many times an order-outbox entry is written to Postgres before it is
// dead-lettered (moved to the dead-letter stream and alerted on, never retried
// automatically). With the capped exponential backoff in
// persist-order-retry.ts (capped at half ORDER_OUTBOX_CLAIM_IDLE_MS between
// passes), 50 attempts ≈ 12 minutes of retrying.
export const PERSIST_ORDER_ATTEMPTS = Number(
  process.env.PERSIST_ORDER_ATTEMPTS ?? 50,
);

// How far back startup reconciliation looks: every sale whose end time is
// within this window is reconciled, older ones are left alone. Bounds the
// startup cost as the sales table grows; anything still stranded on a sale
// older than this needs a manual reconcile.
export const RECONCILE_SALES_WINDOW_MS = Number(
  process.env.RECONCILE_SALES_WINDOW_MS ?? 7 * 24 * 60 * 60 * 1_000,
);

// How long an order-outbox entry may sit unacknowledged because its drainer
// crashed before any live drainer reclaims and retries it. This is the
// self-healing timer for the "Reservation with no pending Order" case — no
// app restart involved. Lower means faster recovery but more chance of two
// drainers racing on the same entry (harmless: the Order insert skips
// duplicates).
export const ORDER_OUTBOX_CLAIM_IDLE_MS = Number(
  process.env.ORDER_OUTBOX_CLAIM_IDLE_MS ?? 30_000,
);

// How long a worker serves the current Sale and a sold-out verdict from memory
// before re-reading Redis. Bounds how long a newly created Sale takes to be
// seen by every worker, and how long an out-of-band stock rewrite goes
// unnoticed; the per-request Redis reads it replaces are the cost.
export const MEMORY_CACHE_TTL_MS = Number(
  process.env.MEMORY_CACHE_TTL_MS ?? 1_000,
);
