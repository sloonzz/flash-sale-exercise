import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { persistOrder } from './persist-order.processor.js';

describe('persistOrder', () => {
  const prisma = new PrismaService();
  const saleIds: string[] = [];

  beforeAll(async () => {
    await prisma.onModuleInit();
  });

  async function createSale(): Promise<string> {
    const sale = await prisma.sale.create({
      data: {
        productName: 'Test Product',
        totalStock: 10,
        startTime: new Date(),
        endTime: new Date(Date.now() + 60_000),
      },
    });
    saleIds.push(sale.id);
    return sale.id;
  }

  afterEach(async () => {
    await prisma.order.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
    saleIds.length = 0;
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('creates a durable Order row for a persisted reservation', async () => {
    const saleId = await createSale();
    const timestamp = new Date('2026-01-01T00:00:00.000Z');

    await persistOrder(prisma, {
      saleId,
      userId: 'user-1',
      timestamp: timestamp.toISOString(),
    });

    const order = await prisma.order.findUniqueOrThrow({
      where: { saleId_userId: { saleId, userId: 'user-1' } },
    });
    expect(order.createdAt).toEqual(timestamp);
  });

  it('is idempotent when the same job is processed twice', async () => {
    const saleId = await createSale();
    const data = {
      saleId,
      userId: 'user-1',
      timestamp: new Date().toISOString(),
    };

    await persistOrder(prisma, data);
    await expect(persistOrder(prisma, data)).resolves.toBeUndefined();

    await expect(prisma.order.count({ where: { saleId } })).resolves.toBe(1);
  });
});
