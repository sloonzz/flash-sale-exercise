import { useQuery } from '@tanstack/react-query';
import { checkSecured } from '../requests/sale.ts';

export function useSecuredQuery(userId: string) {
  return useQuery({
    queryKey: ['secured', userId],
    queryFn: ({ signal }) => checkSecured(userId, signal),
    enabled: userId.length > 0,
  });
}
