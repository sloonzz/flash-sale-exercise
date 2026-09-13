import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../client.ts';
import { getSaleStatus } from '../requests/sale.ts';

const POLL_INTERVAL_MS = 4000;

export function useSaleStatusQuery() {
  return useQuery({
    queryKey: ['saleStatus'],
    queryFn: ({ signal }) => getSaleStatus(signal),
    refetchInterval: POLL_INTERVAL_MS,
    retry: (failureCount, error) =>
      // No sale configured is a steady state, not a transient failure —
      // retrying would just delay showing "No sales available." on load.
      !(error instanceof ApiError && error.status === 404) && failureCount < 3,
  });
}
