import { useMutation } from '@tanstack/react-query';
import { purchase } from '../requests/sale.ts';

export function usePurchaseMutation() {
  return useMutation({
    mutationFn: (userId: string) => purchase(userId),
  });
}
