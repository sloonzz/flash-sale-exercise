export interface CachedSale {
  id: string;
  productName: string;
  totalStock: number;
  startTime: Date;
  endTime: Date;
}

export function currentSaleKey(): string {
  return 'sale:current';
}

/**
 * Keys in the per-worker in-memory cache (Nest CacheModule, MEMORY_CACHE_TTL_MS).
 * `currentSaleKey` doubles as the Redis key the memo sits in front of; Redis
 * stays behind it because it keeps the purchase path off Postgres during a
 * Postgres outage and makes a Sale created on one worker visible to the others
 * within a TTL. The memo stores `null` for "no sale". `soldOutKey` memoises
 * that a Sale is sold out so the sold-out fast path skips Redis: sold out is
 * terminal, so a hit is only wrong if the stock key is rewritten out-of-band.
 * A user who already holds a Reservation gets `sold_out` instead of
 * `already_purchased` on a hit; the secured-status check still tells the truth.
 */
export function soldOutKey(saleId: string): string {
  return `sale:${saleId}:sold-out`;
}

export function serializeSale(sale: CachedSale): string {
  return JSON.stringify({
    id: sale.id,
    productName: sale.productName,
    totalStock: sale.totalStock,
    startTime: sale.startTime.toISOString(),
    endTime: sale.endTime.toISOString(),
  });
}

export function deserializeSale(raw: string): CachedSale {
  const parsed = JSON.parse(raw) as Omit<
    CachedSale,
    'startTime' | 'endTime'
  > & {
    startTime: string;
    endTime: string;
  };

  return {
    ...parsed,
    startTime: new Date(parsed.startTime),
    endTime: new Date(parsed.endTime),
  };
}
