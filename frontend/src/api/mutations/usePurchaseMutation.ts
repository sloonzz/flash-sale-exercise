import { useMutation } from '@tanstack/react-query';
import { purchase } from '../requests/sale.ts';

interface PurchaseVariables {
  userId: string;
  saleId: string;
}

export function usePurchaseMutation() {
  return useMutation({
    mutationFn: ({ userId, saleId }: PurchaseVariables) =>
      purchase(userId, saleId),
  });
}
