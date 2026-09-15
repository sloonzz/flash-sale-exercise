import { randomUUID } from 'node:crypto';
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
import { RECONCILE_SALES_WINDOW_MS, REDIS_URL } from '../config/env.ts';
import { OrderOutboxService } from '../order/order-outbox.service.ts';
import { PrismaService } from '../prisma/prisma.service.ts';
import { reservedUsersKey, stockKey } from '../reservation/reservation-keys.ts';
import { ReservationService } from '../reservation/reservation.service.ts';
import { ReconciliationService } from './reconciliation.service.ts';

describe('ReconciliationService (integration)', () => {
  const prisma = new PrismaService();
  const orderOutbox = {
    append: vi.fn().mockResolvedValue(undefined),
    listDeadLettered: vi.fn().mockResolvedValue([]),
  } as unknown as OrderOutboxService;
  const redis = new Redis(REDIS_URL);
  const reservationService = new ReservationService(
    redis,
    `order-outbox-test-${randomUUID()}`,
  );
  const reconciliationService = new ReconciliationService(
    prisma,
    reservationService,
    orderOutbox,
  );
  const saleIds: string[] = [];

  beforeAll(async () => {
    await prisma.onModuleInit();
  });

  async function createSale(
    totalStock: number,
    endTime = new Date(Date.now() + 60_000),
  ): Promise<string> {
    const sale = await prisma.sale.create({
      data: {
        productName: 'Test Product',
        totalStock,
        startTime: new Date(endTime.getTime() - 60_000),
        endTime,
      },
    });
    saleIds.push(sale.id);
    return sale.id;
  }

  afterEach(async () => {
    vi.clearAllMocks();
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

  it('re-appends outbox entries for reserved users whose Order never landed', async () => {
    const saleId = await createSale(5);
    await prisma.order.create({ data: { saleId, userId: 'user-1' } });
    await reservationService.initializeStock(saleId, 3);
    await reservationService.seedReservedUsers(saleId, ['user-1', 'user-2']);

    await reconciliationService.reconcile(saleId);

    expect(orderOutbox.append).toHaveBeenCalledTimes(1);
    expect(orderOutbox.append).toHaveBeenCalledWith(
      saleId,
      'user-2',
      expect.any(Date),
    );
  });

  it('startup reconciliation repairs an older sale, not just the newest one', async () => {
    const oldSaleId = await createSale(5);
    await prisma.order.create({
      data: { saleId: oldSaleId, userId: 'user-1' },
    });
    await reservationService.initializeStock(oldSaleId, 3);
    await reservationService.seedReservedUsers(oldSaleId, ['user-1', 'user-2']);
    const newSaleId = await createSale(7);

    await reconciliationService.reconcileAllSales();

    expect(await redis.get(stockKey(newSaleId))).toBe('7');
    expect(orderOutbox.append).toHaveBeenCalledTimes(1);
    expect(orderOutbox.append).toHaveBeenCalledWith(
      oldSaleId,
      'user-2',
      expect.any(Date),
    );
  });

  it('startup reconciliation skips sales that ended outside the window', async () => {
    const staleSaleId = await createSale(
      5,
      new Date(Date.now() - RECONCILE_SALES_WINDOW_MS - 60_000),
    );
    await reservationService.seedReservedUsers(staleSaleId, ['user-1']);
    const recentSaleId = await createSale(
      5,
      new Date(Date.now() - RECONCILE_SALES_WINDOW_MS + 60_000),
    );
    await reservationService.seedReservedUsers(recentSaleId, ['user-2']);

    await reconciliationService.reconcileAllSales();

    expect(await redis.get(stockKey(staleSaleId))).toBeNull();
    expect(await redis.get(stockKey(recentSaleId))).toBe('5');
    expect(orderOutbox.append).toHaveBeenCalledTimes(1);
    expect(orderOutbox.append).toHaveBeenCalledWith(
      recentSaleId,
      'user-2',
      expect.any(Date),
    );
  });
});
