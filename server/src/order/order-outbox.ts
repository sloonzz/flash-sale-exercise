/**
 * The order outbox: a Redis stream that the reserve script appends to in the
 * same atomic Lua call that decrements stock and marks the user reserved.
 *
 * It is the transactional-outbox pattern with Redis as the single store: a
 * Reservation and the record of "an Order must be persisted for it" are one
 * write, so there is no window in which a process crash can leave a
 * Reservation with no pending Order. The OrderOutboxDrainer writes entries to
 * Postgres and only acknowledges them once the Order rows are there.
 *
 * Entries that keep failing are moved to a dead-letter stream next to the
 * outbox (see OrderOutboxDrainer); OrderOutboxService lists and replays them.
 */
export const ORDER_OUTBOX_KEY = 'ORDER_OUTBOX_KEY';
export const ORDER_OUTBOX_DEFAULT_KEY = 'order-outbox';
export const ORDER_OUTBOX_GROUP = 'persist-order';

export function orderOutboxDeadLetterKey(outboxKey: string): string {
  return `${outboxKey}:dead-letter`;
}

export interface OrderOutboxEntry {
  id: string;
  saleId: string;
  userId: string;
  timestamp: string;
}

export interface DeadLetteredOrder extends OrderOutboxEntry {
  attempts: number;
  error: string;
}

// Field names must match the XADD in reserve-script.ts
export function orderOutboxFields(
  entry: Pick<OrderOutboxEntry, 'saleId' | 'userId' | 'timestamp'>,
): string[] {
  return [
    'saleId',
    entry.saleId,
    'userId',
    entry.userId,
    'timestamp',
    entry.timestamp,
  ];
}

export function parseOrderOutboxEntry(
  id: string,
  fields: string[] | null,
): OrderOutboxEntry {
  const record = toRecord(fields);
  return {
    id,
    saleId: record.saleId,
    userId: record.userId,
    timestamp: record.timestamp,
  };
}

export function deadLetterFields(
  entry: OrderOutboxEntry,
  attempts: number,
  error: string,
): string[] {
  return [
    ...orderOutboxFields(entry),
    'attempts',
    String(attempts),
    'error',
    error,
  ];
}

export function parseDeadLetteredOrder(
  id: string,
  fields: string[] | null,
): DeadLetteredOrder {
  const record = toRecord(fields);
  return {
    ...parseOrderOutboxEntry(id, fields),
    attempts: Number(record.attempts),
    error: record.error,
  };
}

function toRecord(fields: string[] | null): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; fields && i + 1 < fields.length; i += 2) {
    record[fields[i]] = fields[i + 1];
  }
  return record;
}
