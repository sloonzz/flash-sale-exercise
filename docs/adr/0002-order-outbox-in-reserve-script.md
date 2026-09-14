# The reserve script writes the order outbox; nothing is enqueued from the request path

Status: accepted

[ADR-0001](./0001-redis-reservation-postgres-order.md) made the Reservation a Redis Lua script and the Order an async Postgres write fed by a BullMQ job. Originally the job was enqueued from the request handler right after the script returned `success`, fire-and-forget. That left a window — between `EVAL` returning and `queue.add` landing — in which a process crash, or a failed `add`, produced a Reservation with no pending Order. Those orphans were only found by reconciliation on the next app restart or sale creation.

## Considered Options

- **Run reconciliation on a timer** (cron every N seconds): heals without a restart, and is safe to run from every replica since every step is idempotent (`SET NX`, `EXISTS`-guarded seed, job-id dedupe, upsert). But `reconcile()` is O(N) on the hot store — `SMEMBERS` of the reserved-user set and `findMany` of every Order for the sale, plus `getFailed()` pulling the whole dead-letter set — so a 1-minute cron schedules a Redis stall into the middle of the live sale. Fixable (`SSCAN`, only ended sales, a replica), but it treats the symptom.
- **Enqueue the BullMQ job inside the Lua script**: no window, but BullMQ's job layout is internal to the library and versioned; hand-writing it in Lua couples us to it.
- **Transactional outbox in the reserve script** (chosen): the script `XADD`s a `{saleId, userId, timestamp}` entry to an outbox stream in the same atomic call as `DECR`/`SADD`. A drainer in each API worker reads the stream through a consumer group, enqueues the BullMQ job, and only then `XACK`s + `XDEL`s the entry. There is no "between" for a crash to land in, and the drainer is a poll loop, so recovery needs no restart.

## Consequences

- A Reservation can never exist without either a pending outbox entry, a queued job, or an Order. The startup/creation reconciliation keeps its "reserved user with no Order → re-enqueue" step as a safety net, but no longer has anything to find in normal operation.
- Recovery is at-least-once, on a timer: an entry whose enqueue threw is retried on the drainer's next pass; an entry held by a crashed drainer is reclaimed by any live drainer via `XAUTOCLAIM` once idle for `ORDER_OUTBOX_CLAIM_IDLE_MS` (default 30s). Re-delivery is harmless because the job id is `saleId|userId` and the Order write is an upsert.
- The drainer must re-read its own pending entries (`XREADGROUP … 0`) before blocking for new ones. Its blocking read is bounded by the Redis command timeout, and a read that times out client-side after Redis has already delivered an entry would otherwise leave that entry in the pending list until the idle reclaim.
- One more Redis connection per worker (the blocking read must not hold the shared client), a stream and consumer group to create on first run and recreate after a Redis wipe, and the hot path pays for one extra `XADD` inside the script.
- The reserve script now takes the outbox key as a third `KEYS` entry and the sale id and timestamp as `ARGV`, so the reservation and the outbox stream must live on the same Redis (fine on a single instance or Sentinel; on Redis Cluster the keys would need a hash tag).
