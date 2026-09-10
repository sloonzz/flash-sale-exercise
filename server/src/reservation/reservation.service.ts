import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_URL } from '../config/env.ts';
import { OrderQueueProducer } from '../order/order-queue.producer.ts';
import { reservedUsersKey, stockKey } from './reservation-keys.ts';
import { RESERVE_SCRIPT } from './reserve-script.ts';
import { SEED_RESERVED_USERS_SCRIPT } from './seed-reserved-users-script.ts';

export type ReservationResult = 'success' | 'already_purchased' | 'sold_out';

@Injectable()
export class ReservationService implements OnModuleDestroy {
  private readonly logger = new Logger(ReservationService.name);
  private readonly redis = new Redis(REDIS_URL);

  constructor(private readonly orderQueueProducer: OrderQueueProducer) {
    // An unhandled 'error' event on an ioredis connection crashes the
    // process; a connection blip must not take down the API.
    this.redis.on('error', (error) =>
      this.logger.error('Redis connection error', error),
    );
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async initializeStock(saleId: string, totalStock: number): Promise<void> {
    await this.redis.set(stockKey(saleId), totalStock, 'NX');
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
    const result = (await this.redis.eval(
      RESERVE_SCRIPT,
      2,
      stockKey(saleId),
      reservedUsersKey(saleId),
      userId,
    )) as ReservationResult;

    if (result === 'success') {
      // The Reservation is already committed and authoritative (per
      // ADR-0001); a transient failure enqueueing its persist-order job
      // must not fail the caller's already-successful purchase.
      try {
        await this.orderQueueProducer.enqueuePersistOrder(
          saleId,
          userId,
          new Date(),
        );
      } catch (error) {
        this.logger.error(
          `Failed to enqueue persist-order job for sale ${saleId}, user ${userId}`,
          error,
        );
      }
    }

    return result;
  }
}
