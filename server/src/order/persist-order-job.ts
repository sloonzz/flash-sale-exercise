export const PERSIST_ORDER_QUEUE = 'persist-order';

export interface PersistOrderJobData {
  saleId: string;
  userId: string;
  timestamp: string;
}

/**
 * Retry policy for persist-order jobs: capped exponential backoff with jitter,
 * for PERSIST_ORDER_ATTEMPTS attempts (see config/env.ts), then dead-letter.
 *
 * BullMQ's built-in `exponential` strategy has no ceiling, so a job that
 * failed 20 times would wait days before trying again. A Postgres outage that
 * lasts minutes should be recovered from within seconds of it ending, so we
 * cap the delay and register this as a custom worker strategy.
 *
 * Delays: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... (±20% jitter).
 *
 * Dead-letter: a job that exhausts its attempts stays in the queue's `failed`
 * set (removeOnFail is off). The consumer logs it as dead-lettered so it can
 * be alerted on, and ReconciliationService retries it once the cause is fixed.
 */
export const PERSIST_ORDER_BACKOFF_TYPE = 'capped-exponential';
export const PERSIST_ORDER_BACKOFF_BASE_MS = 1_000;
export const PERSIST_ORDER_BACKOFF_MAX_MS = 30_000;
export const PERSIST_ORDER_BACKOFF_JITTER = 0.2;

export function persistOrderBackoffDelay(attemptsMade: number): number {
  const exponential =
    PERSIST_ORDER_BACKOFF_BASE_MS * 2 ** Math.max(attemptsMade - 1, 0);
  const capped = Math.min(exponential, PERSIST_ORDER_BACKOFF_MAX_MS);
  const jitter =
    capped * PERSIST_ORDER_BACKOFF_JITTER * (Math.random() * 2 - 1);
  return Math.round(capped + jitter);
}
