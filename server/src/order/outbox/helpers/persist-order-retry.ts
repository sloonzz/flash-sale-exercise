/**
 * Retry policy for persisting Orders: capped exponential backoff with jitter
 * between failed drainer passes (1s doubling to 30s, ±20%), and
 * PERSIST_ORDER_ATTEMPTS attempts per outbox entry before it is dead-lettered.
 * The cap keeps recovery from a minutes-long Postgres outage to seconds, and
 * the drainer caps further at half ORDER_OUTBOX_CLAIM_IDLE_MS so a drainer
 * waiting out a backoff is never mistaken for a dead one. A dead-lettered
 * entry is never retried by the system: a human replays it via
 * OrderOutboxService.replayDeadLettered once the cause is fixed.
 */
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
