/**
 * The order outbox: a Redis stream that the reserve script appends to in the
 * same atomic Lua call that decrements stock and marks the user reserved.
 *
 * It is the transactional-outbox pattern with Redis as the single store: a
 * Reservation and the record of "an Order must be persisted for it" are one
 * write, so there is no window in which a process crash (or a failed
 * `queue.add`) can leave a Reservation with no pending Order. The
 * OrderOutboxDrainer moves entries from the stream into the BullMQ
 * persist-order queue and only acknowledges them once the job is on the queue.
 */
export const ORDER_OUTBOX_KEY = 'ORDER_OUTBOX_KEY';
export const ORDER_OUTBOX_DEFAULT_KEY = 'order-outbox';
export const ORDER_OUTBOX_GROUP = 'persist-order';

export interface OrderOutboxEntry {
  id: string;
  saleId: string;
  userId: string;
  timestamp: string;
}

// Field names must match the XADD in reserve-script.ts
export function parseOrderOutboxEntry(
  id: string,
  fields: string[] | null,
): OrderOutboxEntry {
  const record: Record<string, string> = {};
  for (let i = 0; fields && i + 1 < fields.length; i += 2) {
    record[fields[i]] = fields[i + 1];
  }
  return {
    id,
    saleId: record.saleId,
    userId: record.userId,
    timestamp: record.timestamp,
  };
}
