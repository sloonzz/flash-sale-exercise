import { useQuery } from '@tanstack/react-query';
import { ApiError, getSaleStatus } from '../api/client.ts';
import type { SaleStatusResponse } from 'common';

const POLL_INTERVAL_MS = 4000;

interface UseSaleStatusResult {
  saleStatus: SaleStatusResponse | undefined;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSaleStatus(): UseSaleStatusResult {
  const query = useQuery({
    queryKey: ['saleStatus'],
    queryFn: ({ signal }) => getSaleStatus(signal),
    refetchInterval: POLL_INTERVAL_MS,
  });

  return {
    saleStatus: query.data,
    loading: query.isPending,
    error: query.isError
      ? query.error instanceof ApiError
        ? query.error.message
        : 'Failed to load sale status'
      : null,
    refresh: () => {
      void query.refetch();
    },
  };
}
