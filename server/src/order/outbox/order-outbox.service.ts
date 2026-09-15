import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.constants.ts';
import {
  DeadLetteredOrder,
  ORDER_OUTBOX_KEY,
  orderOutboxDeadLetterKey,
  orderOutboxFields,
  parseDeadLetteredOrder,
} from './order-outbox.ts';

/**
 * The non-draining side of the order outbox: appending entries outside the
 * reserve script (reconciliation re-enqueueing an orphaned Reservation) and
 * the dead-letter stream a human inspects and replays from.
 */
@Injectable()
export class OrderOutboxService {
  private readonly deadLetterKey: string;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(ORDER_OUTBOX_KEY) private readonly outboxKey: string,
  ) {
    this.deadLetterKey = orderOutboxDeadLetterKey(outboxKey);
  }

  async append(saleId: string, userId: string, timestamp: Date): Promise<void> {
    await this.redis.xadd(
      this.outboxKey,
      '*',
      ...orderOutboxFields({
        saleId,
        userId,
        timestamp: timestamp.toISOString(),
      }),
    );
  }

  async listDeadLettered(saleId: string): Promise<string[]> {
    const entries = await this.deadLettered(saleId);
    return entries.map((entry) => entry.userId);
  }

  /**
   * Manual intervention: put a dead-lettered entry back in the outbox, where
   * the drainer retries it with a fresh attempt count. Returns false if the
   * user has no dead-lettered entry for that sale.
   */
  async replayDeadLettered(saleId: string, userId: string): Promise<boolean> {
    const entries = (await this.deadLettered(saleId)).filter(
      (entry) => entry.userId === userId,
    );
    if (entries.length === 0) return false;

    const multi = this.redis.multi();
    for (const entry of entries) {
      multi.xadd(this.outboxKey, '*', ...orderOutboxFields(entry));
    }
    multi.xdel(this.deadLetterKey, ...entries.map((entry) => entry.id));
    await multi.exec();
    return true;
  }

  private async deadLettered(saleId: string): Promise<DeadLetteredOrder[]> {
    const entries = await this.redis.xrange(this.deadLetterKey, '-', '+');
    return entries
      .map(([id, fields]) => parseDeadLetteredOrder(id, fields))
      .filter((entry) => entry.saleId === saleId);
  }
}
