import { z } from 'zod';

export type SaleStatus = 'upcoming' | 'active' | 'soldout' | 'ended';

export interface SaleStatusResponse {
  status: SaleStatus;
  startTime: string;
  endTime: string;
  product: string;
}

export type PurchaseResult =
  'success' | 'already_purchased' | 'sold_out' | 'ended' | 'not_active';

export interface PurchaseResponse {
  result: PurchaseResult;
}

export interface SecuredResponse {
  secured: boolean;
}

export const userIdSchema = z
  .string({ error: 'userId is required' })
  .trim()
  .min(1, 'userId is required');

export const purchaseBodySchema = z.object({
  userId: userIdSchema,
});
export type PurchaseBody = z.infer<typeof purchaseBodySchema>;

export const createSaleBodySchema = z
  .object({
    productName: z
      .string({ error: 'productName is required' })
      .trim()
      .min(1, 'productName is required'),
    totalStock: z
      .number()
      .int('totalStock must be a non-negative integer')
      .nonnegative('totalStock must be a non-negative integer'),
    startTime: z.coerce.date({ error: 'startTime must be a valid date' }),
    endTime: z.coerce.date({ error: 'endTime must be a valid date' }),
  })
  .refine((data) => data.startTime < data.endTime, {
    message: 'startTime must be before endTime',
    path: ['startTime'],
  });
export type CreateSaleBody = z.infer<typeof createSaleBodySchema>;

// Wire-level request/response shapes (JSON over HTTP), as opposed to
// `CreateSaleBody`, which is the post-validation shape (dates coerced) used
// internally by the server.
export interface CreateSaleRequest {
  productName: string;
  totalStock: number;
  startTime: string;
  endTime: string;
}

export interface CreateSaleResponse {
  id: string;
  product: string;
  totalStock: number;
  startTime: string;
  endTime: string;
}
