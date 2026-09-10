import { z } from 'zod';

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
