import { useMutation } from '@tanstack/react-query';
import type { CreateSaleRequest } from 'common';
import { createSale } from '../requests/admin.ts';

interface CreateSaleVariables {
  input: CreateSaleRequest;
  adminKey: string;
}

export function useCreateSaleMutation() {
  return useMutation({
    mutationFn: ({ input, adminKey }: CreateSaleVariables) =>
      createSale(input, adminKey),
  });
}
