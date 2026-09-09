import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_URL } from '../config/env.js';
import { reservedUsersKey, stockKey } from './reservation-keys.js';
import { RESERVE_SCRIPT } from './reserve-script.js';

export type ReservationResult = 'success' | 'already_purchased' | 'sold_out';

@Injectable()
export class ReservationService implements OnModuleDestroy {
  // ioredis connects eagerly on construction and queues commands until ready,
  // so there's no separate OnModuleInit step (unlike PrismaService's explicit $connect()).
  private readonly redis = new Redis(REDIS_URL);

  async onModuleDestroy() {
    await this.redis.quit();
  }

  // Reconciliation (see CONTEXT.md) owns deriving this from Postgres; this
  // only guards against clobbering a live counter with a stale seed.
  async initializeStock(saleId: string, totalStock: number): Promise<void> {
    await this.redis.set(stockKey(saleId), totalStock, 'NX');
  }

  async reserve(saleId: string, userId: string): Promise<ReservationResult> {
    const result = await this.redis.eval(RESERVE_SCRIPT, 2, stockKey(saleId), reservedUsersKey(saleId), userId);
    return result as ReservationResult;
  }
}
