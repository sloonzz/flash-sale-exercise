import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { PERSIST_ORDER_DLQ_SWEEP_MS } from '../config/env.ts';
import { PrismaService } from '../prisma/prisma.service.ts';
import { REDIS_CLIENT } from '../redis/redis.constants.ts';
import { OrderQueueProducer } from './order-queue.producer.ts';
import { PERSIST_ORDER_QUEUE } from './persist-order-job.ts';

export const DLQ_SWEEP_LEASE_KEY = `${PERSIST_ORDER_QUEUE}:dlq-sweep-lease`;
export const DLQ_SWEEP_INTERVAL_MS = 'DLQ_SWEEP_INTERVAL_MS';

/**
 * Periodically replays dead-lettered persist-order jobs once Postgres is back.
 */
@Injectable()
export class DeadLetterSweeper
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(DeadLetterSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly orderQueueProducer: OrderQueueProducer,
    @Optional()
    @Inject(DLQ_SWEEP_INTERVAL_MS)
    private readonly intervalMs: number = PERSIST_ORDER_DLQ_SWEEP_MS,
  ) {}

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    // Never keep the process alive just for the sweep
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async sweep(): Promise<string[]> {
    try {
      const deadLettered = await this.orderQueueProducer.countDeadLettered();
      if (deadLettered === 0) return [];

      if (!(await this.acquireLease())) return [];

      if (!(await this.postgresIsUp())) {
        this.logger.warn(
          `${deadLettered} dead-lettered persist-order job(s) waiting; Postgres still unreachable, will retry next sweep`,
        );
        return [];
      }

      const retried = await this.orderQueueProducer.retryDeadLettered();
      if (retried.length > 0) {
        this.logger.warn(
          `Sweep retried ${retried.length} dead-lettered persist-order job(s)`,
        );
      }
      return retried;
    } catch (error) {
      this.logger.error('Dead-letter sweep failed', error);
      return [];
    }
  }

  private async acquireLease(): Promise<boolean> {
    const result = await this.redis.set(
      DLQ_SWEEP_LEASE_KEY,
      process.pid,
      'PX',
      Math.max(this.intervalMs, 1),
      'NX',
    );
    return result === 'OK';
  }

  private async postgresIsUp(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
