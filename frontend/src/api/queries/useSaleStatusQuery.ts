import { useQuery } from '@tanstack/react-query';
import { getSaleStatus } from '../requests/sale.ts';

const POLL_INTERVAL_MS = 4000;

export function useSaleStatusQuery() {
  return useQuery({
    queryKey: ['saleStatus'],
    queryFn: ({ signal }) => getSaleStatus(signal),
    refetchInterval: POLL_INTERVAL_MS,
  });
}
