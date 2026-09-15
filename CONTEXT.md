# Flash Sale

A single-product, limited-stock, time-boxed sale where each user may purchase at most one unit, correctly enforced under high concurrent load.

## Language

**Sale**:
A time-boxed event for one Product: a configured Stock count, a start time, and an end time. Configuring a new Sale appends a row rather than overwriting the old one, but exactly one Sale is ever current: the earliest-starting row that is neither sold out nor past its end time. If no row qualifies (every Sale is sold out or ended), the row with the latest start time is current instead, so a terminal status (SoldOut/Ended) still has a Sale to attach to. Rows that aren't current are retained only as history — they are never read by status, purchase, or secured checks.

**Product**:
The single item being sold in a Sale. Modeled minimally (id, name) — not a general catalog concept.

**Stock**:
The count of units not yet claimed by a Reservation. Its live, authoritative value lives in Redis during the Sale; its configured starting value is set on the Sale in Postgres.
_Avoid_: Inventory, Quantity.

**User**:
Identified only by a caller-supplied identifier (email/username) — no authentication, just an identity string.
_Avoid_: Customer, Account.

**Reservation**:
The atomic, immediate claim of one unit of Stock by a User, decided the instant a purchase attempt is accepted. This is the moment of truth — it's what makes a purchase succeed or fail, and it's what "one item per user" is actually enforced against (a Reservation existing for a User blocks a second one, independent of the Stock count). Lives in Redis. To the User it is presented as a hold ("reserved"), never as a confirmation: the confirmation is the Order.
_Avoid_: Confirmed, Purchased (for this state). To the User it is a *hold*, shown as "reserved", never as "confirmed" — see Secured status.
_Avoid_: Confirmation, Purchase confirmed (those belong to the Order).

**Order outbox**:
A Redis stream the reserve script appends to in the same atomic call that makes a Reservation, recording that an Order must be persisted for it. Because it is written with the Reservation, not after it, a Reservation can never exist without its outbox entry. A drainer in each API worker reads it through a consumer group, writes each batch of entries to Postgres as Orders, and acknowledges them only once the rows are there; unacknowledged entries are retried by their drainer on its next pass (with backoff) and reclaimed from a dead drainer after an idle timer. An entry that has failed a configured number of attempts is moved to a dead-letter stream beside the outbox, where it waits for a human to replay it. Consumers are named per process and never expire on their own, so a drainer removes its own on graceful shutdown and, when it joins the group, prunes any consumer that is idle past the claim timer with nothing pending (the process is gone and its entries have already been reclaimed). The transactional-outbox pattern, with Redis as the single store.
_Avoid_: Pending order, Event log.

**Order**:
The durable record that a Reservation succeeded, persisted to Postgres asynchronously after the Reservation is made. This is the *confirmation*: what "check if I secured an item" reflects, what the User is shown as "confirmed", and what downstream concerns (history, reporting, refunds, fulfillment) read from. A Reservation is authoritative the instant it happens; the Order write is guaranteed-eventually and never rolled back on failure — it's retried until it lands.
_Avoid_: Purchase, Transaction (as the persisted-record term — "purchase attempt" is fine as the verb for the user's action).

**Secured status**:
Where a User's purchase attempt stands, answered by `GET /purchase/:saleId` from the durable side out: `confirmed` (an Order row exists in Postgres — the only state that means "you got one"), `reserved` (a Reservation exists in Redis but its Order has not landed yet; the hold is kept and the page keeps polling), `none` (neither). Postgres is checked first; Redis only on a miss, to tell a pending hold from no attempt.
_Avoid_: Secured (as a boolean), Pending.

**Sale status**:
Two independent terminal conditions, not one: `SoldOut` (Stock reaches zero before the end time) and `Ended` (the clock passes the end time regardless of remaining Stock). Lifecycle: `Upcoming → Active → (SoldOut | Ended)`. Once either terminal state is reached, no further Reservations are accepted.

**Reconciliation (seeding)**:
The idempotent operation that derives Redis's live Stock counter and reserved-User set from Postgres's durably persisted Orders: `stock = Sale.total_stock − count(Orders)`, `reserved_users = {u : Order(u) exists}`. Safe to run any number of times — a first-time seed and a post-crash recovery are the same operation. Must only populate a *missing* Redis key, never overwrite a live one, since Postgres's Order count can lag momentarily behind Redis's already-correct state. Also runs the other way: any reserved User with no Order gets an entry re-appended to the Order outbox (idempotent because the Order insert skips duplicates); a dead-lettered one is left for manual intervention. With the Order outbox this is a safety net rather than the mechanism — the outbox is what keeps a Reservation from ever lacking a pending Order. On startup it runs over every Sale that ended within the reconciliation window (7 days by default), not only the current one: creating a new Sale never evicts the previous Sale's Redis keys, and a Reservation on an older Sale can still be waiting for its Order.
