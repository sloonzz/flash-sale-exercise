import { z } from 'zod';

export type SaleStatus = 'upcoming' | 'active' | 'soldout' | 'ended';

export interface ActiveSaleStatusResponse {
  id: string;
  status: SaleStatus;
  startTime: string;
  endTime: string;
  product: string;
}

export interface NoSaleStatusResponse {
  status: 'no_sale';
}

export type SaleStatusResponse =
  ActiveSaleStatusResponse | NoSaleStatusResponse;

export type PurchaseResult =
  | 'success'
  | 'already_purchased'
  | 'sold_out'
  | 'ended'
  | 'not_active'
  | 'invalid_sale';

export interface PurchaseResponse {
  result: PurchaseResult;
}

/**
 * Where a user's purchase attempt stands, from the durable side out:
 * - `confirmed`: an Order row exists in Postgres. This is the only state that
 *   means "you got one".
 * - `reserved`: a Reservation exists in Redis but its Order has not landed yet.
 *   The hold is kept and the Order is still being written; keep polling.
 * - `none`: neither.
 */
export type SecuredStatus = 'confirmed' | 'reserved' | 'none';

export interface SecuredResponse {
  status: SecuredStatus;
}

export interface AdminLoginResponse {
  adminKey: string;
}

export const userIdSchema = z
  .string({ error: 'User ID is required' })
  .trim()
  .min(1, 'User ID is required');

export const saleIdSchema = z
  .string({ error: 'Sale ID is required' })
  .trim()
  .min(1, 'Sale ID is required');

export const purchaseBodySchema = z.object({
  userId: userIdSchema,
  saleId: saleIdSchema,
});
export type PurchaseBody = z.infer<typeof purchaseBodySchema>;

export const createSaleBodySchema = z
  .object({
    productName: z
      .string({ error: 'Product name is required' })
      .trim()
      .min(1, 'Product name is required'),
    totalStock: z
      .number({ error: 'Total stock is required' })
      .int('Total stock must be a whole number')
      .nonnegative('Total stock cannot be negative'),
    startTime: z.coerce.date({ error: 'Start time must be a valid date' }),
    endTime: z.coerce.date({ error: 'End time must be a valid date' }),
  })
  .refine((data) => data.startTime < data.endTime, {
    message: 'Start time must be before end time',
    path: ['startTime'],
  });
export type CreateSaleBody = z.infer<typeof createSaleBodySchema>;

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
