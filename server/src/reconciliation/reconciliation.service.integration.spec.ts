import { Redis } from 'ioredis';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { REDIS_URL } from '../config/env.js';
import { OrderQueueProducer } from '../order/order-queue.producer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { reservedUsersKey, stockKey } from '../reservation/reservation-keys.js';
import { ReservationService } from '../reservation/reservation.service.js';
import { ReconciliationService } from './reconciliation.service.js';

describe('ReconciliationService (integration)', () => {
  const prisma = new PrismaService();
  const orderQueueProducer = {
    enqueuePersistOrder: vi.fn().mockResolvedValue(undefined),
  } as unknown as OrderQueueProducer;
  const reservationService = new ReservationService(orderQueueProducer);
  const reconciliationService = new ReconciliationService(
    prisma,
    reservationService,
  );
  const redis = new Redis(REDIS_URL);
  const saleIds: string[] = [];

  beforeAll(async () => {
    await prisma.onModuleInit();
  });

  async function createSale(totalStock: number): Promise<string> {
    const sale = await prisma.sale.create({
      data: {
        productName: 'Test Product',
        totalStock,
        startTime: new Date(),
        endTime: new Date(Date.now() + 60_000),
      },
    });
    saleIds.push(sale.id);
    return sale.id;
  }

  afterEach(async () => {
    const keys = saleIds.flatMap((saleId) => [
      stockKey(saleId),
      reservedUsersKey(saleId),
    ]);
    if (keys.length > 0) await redis.del(...keys);
    await prisma.order.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
    saleIds.length = 0;
  });

  afterAll(async () => {
    await reservationService.onModuleDestroy();
    await prisma.onModuleDestroy();
    await redis.quit();
  });

  it('seeds full stock and an empty reserved-user set for an empty sale', async () => {
    const saleId = await createSale(10);

    await reconciliationService.reconcile(saleId);

    await expect(redis.get(stockKey(saleId))).resolves.toBe('10');
    await expect(redis.scard(reservedUsersKey(saleId))).resolves.toBe(0);
  });

  it('seeds stock minus existing orders and marks those users reserved', async () => {
    const saleId = await createSale(10);
    await prisma.order.createMany({
      data: [
        { saleId, userId: 'user-1' },
        { saleId, userId: 'user-2' },
      ],
    });

    await reconciliationService.reconcile(saleId);

    await expect(redis.get(stockKey(saleId))).resolves.toBe('8');
    await expect(redis.smembers(reservedUsersKey(saleId))).resolves.toEqual(
      expect.arrayContaining(['user-1', 'user-2']),
    );
  });

  it('does not overwrite a live stock counter that has already diverged from the Order count', async () => {
    const saleId = await createSale(10);
    // Simulate Redis's already-correct, more-current state: a Reservation
    // just landed but its Order hasn't been persisted yet.
    await reservationService.initializeStock(saleId, 9);

    await reconciliationService.reconcile(saleId);

    await expect(redis.get(stockKey(saleId))).resolves.toBe('9');
  });

  it('does not overwrite a live reserved-user set', async () => {
    const saleId = await createSale(10);
    await reservationService.seedReservedUsers(saleId, ['user-9']);

    await prisma.order.create({ data: { saleId, userId: 'user-1' } });
    await reconciliationService.reconcile(saleId);

    await expect(redis.smembers(reservedUsersKey(saleId))).resolves.toEqual([
      'user-9',
    ]);
  });

  it('is idempotent: calling it twice does not change the seeded state', async () => {
    const saleId = await createSale(5);
    await prisma.order.create({ data: { saleId, userId: 'user-1' } });

    await reconciliationService.reconcile(saleId);
    await reconciliationService.reconcile(saleId);

    await expect(redis.get(stockKey(saleId))).resolves.toBe('4');
    await expect(redis.smembers(reservedUsersKey(saleId))).resolves.toEqual([
      'user-1',
    ]);
  });
});
