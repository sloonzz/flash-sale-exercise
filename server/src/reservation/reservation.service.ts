import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ORDER_OUTBOX_KEY } from '../order/outbox/order-outbox.ts';
import { REDIS_CLIENT } from '../redis/redis.constants.ts';
import { reservedUsersKey, stockKey } from './reservation-keys.ts';
import { RESERVE_SCRIPT } from './reserve-script.ts';
import { SEED_RESERVED_USERS_SCRIPT } from './seed-reserved-users-script.ts';

// IMPORTANT: Always sync with reserve-script.ts Lua script
export type ReservationResult = 'success' | 'already_purchased' | 'sold_out';

@Injectable()
export class ReservationService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(ORDER_OUTBOX_KEY) private readonly orderOutboxKey: string,
  ) {}

  async initializeStock(saleId: string, totalStock: number): Promise<void> {
    await this.redis.set(stockKey(saleId), totalStock, 'NX');
  }

  async getStock(saleId: string): Promise<number | null> {
    const stock = await this.redis.get(stockKey(saleId));
    return stock === null ? null : Number(stock);
  }

  async isReserved(saleId: string, userId: string): Promise<boolean> {
    const result = await this.redis.sismember(reservedUsersKey(saleId), userId);
    return result === 1;
  }

  async getReservedUsers(saleId: string): Promise<string[]> {
    return this.redis.smembers(reservedUsersKey(saleId));
  }

  async seedReservedUsers(saleId: string, userIds: string[]): Promise<void> {
    await this.redis.eval(
      SEED_RESERVED_USERS_SCRIPT,
      1,
      reservedUsersKey(saleId),
      ...userIds,
    );
  }

  async reserve(saleId: string, userId: string): Promise<ReservationResult> {
    return (await this.redis.eval(
      RESERVE_SCRIPT,
      3,
      stockKey(saleId),
      reservedUsersKey(saleId),
      this.orderOutboxKey,
      userId,
      saleId,
      new Date().toISOString(),
    )) as ReservationResult;
  }
}
