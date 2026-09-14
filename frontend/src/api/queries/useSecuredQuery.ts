import { useQuery } from '@tanstack/react-query';
import type { SecuredResponse } from 'common';
import { checkSecured } from '../requests/sale.ts';

const CONFIRMATION_POLL_INTERVAL_MS = 1000;

export function securedQueryKey(saleId: string, userId: string) {
  return ['secured', saleId, userId] as const;
}

export function useSecuredQuery(saleId: string | undefined, userId: string) {
  return useQuery<SecuredResponse>({
    queryKey: securedQueryKey(saleId ?? '', userId),
    queryFn: ({ signal }) => checkSecured(userId, saleId!, signal),
    enabled: userId.length > 0 && !!saleId,
    refetchInterval: (query) =>
      query.state.data?.status === 'reserved'
        ? CONFIRMATION_POLL_INTERVAL_MS
        : false,
  });
}
