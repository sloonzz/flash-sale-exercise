import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_URL } from '../config/env.js';
import { reservedUsersKey, stockKey } from './reservation-keys.js';
import { RESERVE_SCRIPT } from './reserve-script.js';

export type ReservationResult = 'success' | 'already_purchased' | 'sold_out';

@Injectable()
export class ReservationService implements OnModuleDestroy {
  private readonly redis = new Redis(REDIS_URL);

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async initializeStock(saleId: string, totalStock: number): Promise<void> {
    await this.redis.set(stockKey(saleId), totalStock, 'NX');
  }

  async reserve(saleId: string, userId: string): Promise<ReservationResult> {
    const result = await this.redis.eval(
      RESERVE_SCRIPT,
      2,
      stockKey(saleId),
      reservedUsersKey(saleId),
      userId,
    );
    return result as ReservationResult;
  }
}
