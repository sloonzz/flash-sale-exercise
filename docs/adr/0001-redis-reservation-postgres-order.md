# Redis owns the Reservation decision, Postgres owns the durable Order

Status: accepted

A purchase attempt needs one atomic decision under heavy concurrent contention (is there Stock, has this User already reserved) and one durable record of the outcome. We split these across two stores rather than using Postgres for both: the Reservation (stock decrement + one-per-user check) is decided atomically in Redis via a single Lua script and answered to the client synchronously; the Order is persisted to Postgres asynchronously afterward, off the request's hot path, via a queue.

## Considered Options

- **Postgres only** (`UPDATE stock SET count = count - 1 WHERE count > 0 RETURNING`, unique constraint on `(sale_id, user_id)`): fully ACID, no cross-store consistency window — but every concurrent purchase attempt serializes on the same row, and each commit pays a WAL fsync. At flash-sale traffic this row is the throughput ceiling of the whole system.
- **Queue + single Postgres-writing consumer**: removes lock contention (one writer), but doesn't remove the per-message fsync cost, and can't be scaled with more consumers without reintroducing the same row contention it was meant to avoid. Making the consumer fast enough to matter means giving it its own in-memory counter — at which point it's a bespoke, non-persistent, single-point-of-failure reimplementation of Redis.
- **Redis reservation + async Postgres order** (chosen): Redis's atomic ops are in-memory and effectively single-threaded per key, so the contended decision is cheap and fast, and it's an external service any number of stateless API replicas can hit concurrently — not a bespoke process. Postgres inserts are per-user and uncontended, so persisting Orders scales trivially with more consumers.

## Consequences

- Introduces an eventual-consistency window between a successful Reservation and its durable Order row; accepted per the rule that the Reservation is authoritative and the Order write is retried until it lands, never rolled back.
- Redis becomes the only place truth briefly lives before it's durable. Mitigated with Redis AOF persistence, plus an idempotent reconciliation (see [[CONTEXT.md]]'s "Reconciliation (seeding)") that rebuilds Redis's counter and reserved-user set from Postgres's Order count — safe to run on first setup or after a crash, but must only fill a missing key, never overwrite a live one.
- The "check if I secured an item" read is served from Redis (the authoritative, instantly-consistent state), not Postgres.
