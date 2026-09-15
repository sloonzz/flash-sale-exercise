import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.ts';
import { persistOrders } from './persist-orders.ts';

describe('persistOrders (integration)', () => {
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

  it('creates a durable Order row for every entry in the batch', async () => {
    const saleId = await createSale();
    const timestamp = new Date('2026-01-01T00:00:00.000Z');

    await persistOrders(prisma, [
      {
        id: '1-0',
        saleId,
        userId: 'user-1',
        timestamp: timestamp.toISOString(),
      },
      {
        id: '2-0',
        saleId,
        userId: 'user-2',
        timestamp: timestamp.toISOString(),
      },
    ]);

    const order = await prisma.order.findUniqueOrThrow({
      where: { saleId_userId: { saleId, userId: 'user-1' } },
    });
    expect(order.createdAt).toEqual(timestamp);
    await expect(prisma.order.count({ where: { saleId } })).resolves.toBe(2);
  });

  it('is idempotent when the same batch is persisted twice, and lands the new rows of a partially-persisted batch', async () => {
    const saleId = await createSale();
    const timestamp = new Date().toISOString();
    const one = { id: '1-0', saleId, userId: 'user-1', timestamp };
    const two = { id: '2-0', saleId, userId: 'user-2', timestamp };

    await persistOrders(prisma, [one]);
    await expect(persistOrders(prisma, [one, two])).resolves.toBeUndefined();
    await expect(persistOrders(prisma, [one, two])).resolves.toBeUndefined();

    await expect(prisma.order.count({ where: { saleId } })).resolves.toBe(2);
  });
});
