import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.ts';
import { persistOrders } from './persist-orders.ts';

describe('persistOrders', () => {
  const prisma = {
    order: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  } as unknown as PrismaService;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts the whole batch in one write, skipping rows that already exist so a retried entry never throws on the unique constraint', async () => {
    const saleId = randomUUID();

    await persistOrders(prisma, [
      {
        id: '1-0',
        saleId,
        userId: 'user-1',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        id: '2-0',
        saleId,
        userId: 'user-2',
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ]);

    expect(prisma.order.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.order.createMany).toHaveBeenCalledWith({
      data: [
        {
          saleId,
          userId: 'user-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          saleId,
          userId: 'user-2',
          createdAt: new Date('2026-01-01T00:00:01.000Z'),
        },
      ],
      skipDuplicates: true,
    });
  });
});
