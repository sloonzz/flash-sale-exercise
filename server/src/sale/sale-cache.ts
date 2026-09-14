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
