import { useQuery } from '@tanstack/react-query';
import { checkSecured } from '../requests/sale.ts';

export function securedQueryKey(saleId: string, userId: string) {
  return ['secured', saleId, userId] as const;
}

export function useSecuredQuery(saleId: string | undefined, userId: string) {
  return useQuery({
    queryKey: securedQueryKey(saleId ?? '', userId),
    queryFn: ({ signal }) => checkSecured(userId, saleId!, signal),
    enabled: userId.length > 0 && !!saleId,
  });
}
