/**
 * Retry policy for persisting Orders: capped exponential backoff with jitter
 * between failed drainer passes, and PERSIST_ORDER_ATTEMPTS attempts per
 * outbox entry (see config/env.ts) before it is dead-lettered.
 *
 * Plain exponential backoff has no ceiling, so an entry that failed 20 times
 * would wait days before trying again. A Postgres outage that lasts minutes
 * should be recovered from within seconds of it ending, so the delay is capped.
 *
 * Delays: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ... (±20% jitter), further capped
 * by the drainer at half ORDER_OUTBOX_CLAIM_IDLE_MS (15s by default) so a
 * drainer waiting out a backoff is never mistaken for a dead one.
 *
 * Dead-letter: an entry that exhausts its attempts is moved to the outbox's
 * dead-letter stream (orderOutboxDeadLetterKey). The drainer logs it as
 * dead-lettered so it can be alerted on. It is the last resort and is never
 * retried by the system: a human investigates and replays it
 * (OrderOutboxService.replayDeadLettered) once the cause is fixed.
 * ReconciliationService skips it rather than re-enqueueing it.
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
