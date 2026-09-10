import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.ts';
import { persistOrder } from './persist-order.processor.ts';

describe('persistOrder', () => {
  const prisma = {
    order: { upsert: vi.fn().mockResolvedValue(undefined) },
  } as unknown as PrismaService;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('upserts the Order keyed by sale and user, so a retried job never throws on the unique constraint', async () => {
    const saleId = randomUUID();
    const timestamp = new Date('2026-01-01T00:00:00.000Z');

    await persistOrder(prisma, {
      saleId,
      userId: 'user-1',
      timestamp: timestamp.toISOString(),
    });

    expect(prisma.order.upsert).toHaveBeenCalledWith({
      where: { saleId_userId: { saleId, userId: 'user-1' } },
      create: { saleId, userId: 'user-1', createdAt: timestamp },
      update: {},
    });
  });
});
