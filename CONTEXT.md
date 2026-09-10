# Flash Sale

A single-product, limited-stock, time-boxed sale where each user may purchase at most one unit, correctly enforced under high concurrent load.

## Language

**Sale**:
A time-boxed event for one Product: a configured Stock count, a start time, and an end time. Configuring a new Sale appends a row rather than overwriting the old one, but exactly one Sale is ever current: the most recently created row. Older rows are retained only as history — they are never read again by status, purchase, or secured checks.

**Product**:
The single item being sold in a Sale. Modeled minimally (id, name) — not a general catalog concept.

**Stock**:
The count of units not yet claimed by a Reservation. Its live, authoritative value lives in Redis during the Sale; its configured starting value is set on the Sale in Postgres.
_Avoid_: Inventory, Quantity.

**User**:
Identified only by a caller-supplied identifier (email/username) — no authentication, just an identity string.
_Avoid_: Customer, Account.

**Reservation**:
The atomic, immediate claim of one unit of Stock by a User, decided the instant a purchase attempt is accepted. This is the moment of truth — it's what makes a purchase succeed or fail, and it's what "one item per user" is actually enforced against (a Reservation existing for a User blocks a second one, independent of the Stock count). Lives in Redis.

**Order**:
The durable record that a Reservation succeeded, persisted to Postgres asynchronously after the Reservation is made. This is what "check if I secured an item" ultimately reflects, and what downstream concerns (history, reporting, refunds, fulfillment) read from. A Reservation is authoritative the instant it happens; the Order write is guaranteed-eventually and never rolled back on failure — it's retried until it lands.
_Avoid_: Purchase, Transaction (as the persisted-record term — "purchase attempt" is fine as the verb for the user's action).

**Sale status**:
Two independent terminal conditions, not one: `SoldOut` (Stock reaches zero before the end time) and `Ended` (the clock passes the end time regardless of remaining Stock). Lifecycle: `Upcoming → Active → (SoldOut | Ended)`. Once either terminal state is reached, no further Reservations are accepted.

**Reconciliation (seeding)**:
The idempotent operation that derives Redis's live Stock counter and reserved-User set from Postgres's durably persisted Orders: `stock = Sale.total_stock − count(Orders)`, `reserved_users = {u : Order(u) exists}`. Safe to run any number of times — a first-time seed and a post-crash recovery are the same operation. Must only populate a *missing* Redis key, never overwrite a live one, since Postgres's Order count can lag momentarily behind Redis's already-correct state.
