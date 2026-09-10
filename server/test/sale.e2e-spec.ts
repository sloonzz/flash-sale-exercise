import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { REDIS_URL } from '../src/config/env.ts';
import { PrismaService } from '../src/prisma/prisma.service.ts';
import {
  reservedUsersKey,
  stockKey,
} from '../src/reservation/reservation-keys.ts';

const ADMIN_KEY = 'test-admin-key';

describe('Sale API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const redis = new Redis(REDIS_URL);
  const saleIds: string[] = [];

  beforeAll(async () => {
    process.env.ADMIN_KEY = ADMIN_KEY;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

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
    await app.close();
    await redis.quit();
  });

  async function createSale(
    overrides: {
      productName?: string;
      totalStock?: number;
      startTime?: Date;
      endTime?: Date;
    } = {},
  ): Promise<string> {
    const now = Date.now();
    const response = await request(app.getHttpServer())
      .post('/admin/sales')
      .set('x-admin-key', ADMIN_KEY)
      .send({
        productName: overrides.productName ?? 'Test Widget',
        totalStock: overrides.totalStock ?? 10,
        startTime: (
          overrides.startTime ?? new Date(now - 60_000)
        ).toISOString(),
        endTime: (overrides.endTime ?? new Date(now + 60_000)).toISOString(),
      })
      .expect(201);

    saleIds.push(response.body.id);
    return response.body.id;
  }

  async function waitForOrder(saleId: string, userId: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const order = await prisma.order.findUnique({
        where: { saleId_userId: { saleId, userId } },
      });
      if (order) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Order for sale ${saleId} user ${userId} was not persisted in time`,
    );
  }

  describe('POST /admin/sales', () => {
    it('rejects a request with no x-admin-key header', async () => {
      await request(app.getHttpServer())
        .post('/admin/sales')
        .send({
          productName: 'Widget',
          totalStock: 10,
          startTime: new Date().toISOString(),
          endTime: new Date(Date.now() + 60_000).toISOString(),
        })
        .expect(401);
    });

    it('rejects a request with the wrong x-admin-key header', async () => {
      await request(app.getHttpServer())
        .post('/admin/sales')
        .set('x-admin-key', 'wrong-key')
        .send({
          productName: 'Widget',
          totalStock: 10,
          startTime: new Date().toISOString(),
          endTime: new Date(Date.now() + 60_000).toISOString(),
        })
        .expect(403);
    });

    it('creates the sale and immediately seeds Redis via reconciliation', async () => {
      const saleId = await createSale({ totalStock: 7 });

      await expect(redis.get(stockKey(saleId))).resolves.toBe('7');
    });

    it('appends a new sale row instead of overwriting the previous one, and the earliest open sale becomes current', async () => {
      const firstId = await createSale({
        totalStock: 5,
        startTime: new Date(Date.now() - 120_000),
      });

      const response = await request(app.getHttpServer())
        .post('/admin/sales')
        .set('x-admin-key', ADMIN_KEY)
        .send({
          productName: 'Test Widget v2',
          totalStock: 20,
          startTime: new Date(Date.now() - 60_000).toISOString(),
          endTime: new Date(Date.now() + 60_000).toISOString(),
        })
        .expect(201);
      saleIds.push(response.body.id);

      expect(response.body.id).not.toBe(firstId);
      await expect(
        prisma.sale.count({
          where: { id: { in: [firstId, response.body.id] } },
        }),
      ).resolves.toBe(2);

      const status = await request(app.getHttpServer())
        .get('/sale/status')
        .expect(200);
      expect(status.body.product).toBe('Test Widget');
    });

    it('treats the earliest open row as current, even when a later row was created first', async () => {
      await request(app.getHttpServer())
        .post('/admin/sales')
        .set('x-admin-key', ADMIN_KEY)
        .send({
          productName: 'Later Start',
          totalStock: 10,
          startTime: new Date(Date.now() - 30_000).toISOString(),
          endTime: new Date(Date.now() + 60_000).toISOString(),
        })
        .expect(201)
        .then((response) => saleIds.push(response.body.id));

      await request(app.getHttpServer())
        .post('/admin/sales')
        .set('x-admin-key', ADMIN_KEY)
        .send({
          productName: 'Earlier Start',
          totalStock: 10,
          startTime: new Date(Date.now() - 90_000).toISOString(),
          endTime: new Date(Date.now() + 60_000).toISOString(),
        })
        .expect(201)
        .then((response) => saleIds.push(response.body.id));

      const status = await request(app.getHttpServer())
        .get('/sale/status')
        .expect(200);
      expect(status.body.product).toBe('Earlier Start');
    });

    it('skips a sold-out earlier sale in favor of the next open one', async () => {
      const soldOutId = await createSale({
        productName: 'Sold Out',
        totalStock: 1,
        startTime: new Date(Date.now() - 120_000),
      });
      await request(app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1' })
        .expect(201);
      await waitForOrder(soldOutId, 'user-1');

      await createSale({
        productName: 'Open',
        totalStock: 10,
        startTime: new Date(Date.now() - 60_000),
      });

      const status = await request(app.getHttpServer())
        .get('/sale/status')
        .expect(200);
      expect(status.body.product).toBe('Open');
      expect(status.body.status).toBe('active');
    });

    it('falls back to the latest start time when every sale is sold out or ended', async () => {
      await createSale({
        totalStock: 10,
        startTime: new Date(Date.now() - 120_000),
        endTime: new Date(Date.now() - 60_000),
      });
      await createSale({
        totalStock: 1,
        startTime: new Date(Date.now() - 30_000),
      });
      await request(app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1' })
        .expect(201);

      const status = await request(app.getHttpServer())
        .get('/sale/status')
        .expect(200);
      expect(status.body.status).toBe('soldout');
    });
  });

  describe('POST /admin/login', () => {
    it('rejects a request with no x-admin-key header', async () => {
      await request(app.getHttpServer())
        .post('/admin/login')
        .send()
        .expect(401);
    });

    it('rejects a request with the wrong x-admin-key header', async () => {
      await request(app.getHttpServer())
        .post('/admin/login')
        .set('x-admin-key', 'wrong-key')
        .send()
        .expect(403);
    });

    it('returns the admin key when it matches', async () => {
      const response = await request(app.getHttpServer())
        .post('/admin/login')
        .set('x-admin-key', ADMIN_KEY)
        .send()
        .expect(201);

      expect(response.body).toEqual({ adminKey: ADMIN_KEY });
    });
  });

  describe('GET /sale/status', () => {
    it('reports upcoming before the start time', async () => {
      await createSale({
        startTime: new Date(Date.now() + 60_000),
        endTime: new Date(Date.now() + 120_000),
      });

      const response = await request(app.getHttpServer())
        .get('/sale/status')
        .expect(200);

      expect(response.body.status).toBe('upcoming');
    });

    it('reports active while stock remains inside the time window', async () => {
      await createSale();

      const response = await request(app.getHttpServer())
        .get('/sale/status')
        .expect(200);

      expect(response.body.status).toBe('active');
    });

    it('reports ended after the end time', async () => {
      await createSale({
        startTime: new Date(Date.now() - 120_000),
        endTime: new Date(Date.now() - 60_000),
      });

      const response = await request(app.getHttpServer())
        .get('/sale/status')
        .expect(200);

      expect(response.body.status).toBe('ended');
    });
  });

  describe('POST /purchase + GET /purchase/:userId', () => {
    it('succeeds for a first-time purchase and reflects it in the check-secured read', async () => {
      const saleId = await createSale();

      const purchaseResponse = await request(app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1' })
        .expect(201);
      expect(purchaseResponse.body.result).toBe('success');

      const checkResponse = await request(app.getHttpServer())
        .get('/purchase/user-1')
        .expect(200);
      expect(checkResponse.body.secured).toBe(true);

      await waitForOrder(saleId, 'user-1');
    });

    it('rejects a repeat purchase as already_purchased', async () => {
      const saleId = await createSale();
      await request(app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1' })
        .expect(201);

      expect(response.body.result).toBe('already_purchased');

      await waitForOrder(saleId, 'user-1');
    });

    it('rejects once stock is exhausted', async () => {
      const saleId = await createSale({ totalStock: 1 });
      await request(app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-2' })
        .expect(201);

      expect(response.body.result).toBe('sold_out');

      await waitForOrder(saleId, 'user-1');
    });

    it('rejects before the sale has started, without granting a reservation', async () => {
      await createSale({
        startTime: new Date(Date.now() + 60_000),
        endTime: new Date(Date.now() + 120_000),
      });

      const response = await request(app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1' })
        .expect(201);

      expect(response.body.result).toBe('not_active');
    });

    it('rejects after the sale has ended', async () => {
      await createSale({
        startTime: new Date(Date.now() - 120_000),
        endTime: new Date(Date.now() - 60_000),
      });

      const response = await request(app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1' })
        .expect(201);

      expect(response.body.result).toBe('ended');
    });

    it('rejects a purchase with no userId', async () => {
      await createSale();

      await request(app.getHttpServer()).post('/purchase').send({}).expect(400);
    });

    it('reports secured: false for a user who has not purchased', async () => {
      await createSale();

      const response = await request(app.getHttpServer())
        .get('/purchase/never-bought')
        .expect(200);

      expect(response.body.secured).toBe(false);
    });
  });
});
