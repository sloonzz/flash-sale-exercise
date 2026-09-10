import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { OrderQueueProducer } from '../order/order-queue.producer.ts';
import { REDIS_CLIENT } from '../redis/redis.constants.ts';
import { reservedUsersKey, stockKey } from './reservation-keys.ts';
import { RESERVE_SCRIPT } from './reserve-script.ts';
import { SEED_RESERVED_USERS_SCRIPT } from './seed-reserved-users-script.ts';

export type ReservationResult = 'success' | 'already_purchased' | 'sold_out';

@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly orderQueueProducer: OrderQueueProducer,
  ) {}

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
