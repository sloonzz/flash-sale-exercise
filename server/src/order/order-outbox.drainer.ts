import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  ORDER_OUTBOX_CLAIM_IDLE_MS,
  REDIS_COMMAND_TIMEOUT_MS,
} from '../config/env.ts';
import { REDIS_CLIENT } from '../redis/redis.constants.ts';
import {
  ORDER_OUTBOX_GROUP,
  ORDER_OUTBOX_KEY,
  OrderOutboxEntry,
  parseOrderOutboxEntry,
} from './order-outbox.ts';
import { OrderQueueProducer } from './order-queue.producer.ts';

export const ORDER_OUTBOX_BATCH_SIZE = 100;
// XREADGROUP blocks the connection for up to this long waiting for a new
// entry. Kept under the Redis command timeout so an idle wait isn't reported
// as a failure, and short so shutdown is prompt.
export const ORDER_OUTBOX_BLOCK_MS = Math.min(
  1_000,
  Math.floor(REDIS_COMMAND_TIMEOUT_MS / 2),
);
const ORDER_OUTBOX_ERROR_BACKOFF_MS = 1_000;

type StreamEntries = [id: string, fields: string[] | null][];

/**
 * Moves order-outbox entries into the BullMQ persist-order queue.
 *
 * Every cluster worker runs one, all in the same consumer group, so entries
 * are spread across workers and any number of them can run concurrently
 * without coordination. An entry is acknowledged (and deleted from the
 * stream) only after `queue.add` resolves. Until then it sits in the group's
 * pending list, owned by this consumer, and is retried:
 *   - by this drainer on its next pass, if the enqueue threw or a blocking
 *     read timed out after Redis had already delivered the entry (the reply
 *     arrives late and nobody is listening for it);
 *   - by whichever drainer is alive, once it has been idle for
 *     ORDER_OUTBOX_CLAIM_IDLE_MS, if this process died holding it.
 * The persist-order job id (`saleId|userId`) makes a re-delivered entry a
 * no-op, so at-least-once here is safe.
 *
 * Uses its own Redis connection: XREADGROUP ... BLOCK holds the connection,
 * and the shared client must stay free for the purchase hot path.
 */
@Injectable()
export class OrderOutboxDrainer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OrderOutboxDrainer.name);
  private readonly consumerName = `${hostname()}:${process.pid}`;
  private readonly client: Redis;
  private groupReady = false;
  private running = false;
  private loop: Promise<void> = Promise.resolve();

  constructor(
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(ORDER_OUTBOX_KEY) private readonly outboxKey: string,
    private readonly orderQueueProducer: OrderQueueProducer,
  ) {
    this.client = redis.duplicate();
    this.client.on('error', (error) =>
      this.logger.error('Order outbox Redis connection error', error),
    );
  }

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loop;
    await this.client.quit();
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.drainOnce();
      } catch (error) {
        // Redis wiped or unreachable: recreate the group on the next pass and
        // keep looping — the app stays up, entries wait in the stream.
        if (isNoGroupError(error)) this.groupReady = false;
        this.logger.error('Failed to drain the order outbox', error);
        await sleep(ORDER_OUTBOX_ERROR_BACKOFF_MS);
      }
    }
  }

  /**
   * One pass: retry what this consumer already holds, reclaim entries
   * stranded by a dead drainer, then read new ones, and enqueue each.
   * Returns how many entries were handled.
   */
  async drainOnce(): Promise<number> {
    await this.ensureGroup();

    const entries = dedupeById([
      ...(await this.readOwnPending()),
      ...(await this.claimStale()),
      ...(await this.readNew()),
    ]);
    if (entries.length === 0) return 0;

    const enqueued = await Promise.all(
      entries.map((entry) => this.enqueue(entry)),
    );
    const acked = entries.filter((_, i) => enqueued[i]).map(({ id }) => id);
    if (acked.length > 0) {
      await this.client
        .multi()
        .xack(this.outboxKey, ORDER_OUTBOX_GROUP, ...acked)
        .xdel(this.outboxKey, ...acked)
        .exec();
    }
    return entries.length;
  }

  private async ensureGroup(): Promise<void> {
    if (this.groupReady) return;
    try {
      // From id 0 so entries appended before the group existed (first boot,
      // or Redis came back empty and the reserve script recreated the
      // stream) are still delivered.
      await this.client.xgroup(
        'CREATE',
        this.outboxKey,
        ORDER_OUTBOX_GROUP,
        '0',
        'MKSTREAM',
      );
    } catch (error) {
      if (!isBusyGroupError(error)) throw error;
    }
    this.groupReady = true;
  }

  private async claimStale(): Promise<OrderOutboxEntry[]> {
    const [, entries] = (await this.client.xautoclaim(
      this.outboxKey,
      ORDER_OUTBOX_GROUP,
      this.consumerName,
      ORDER_OUTBOX_CLAIM_IDLE_MS,
      '0-0',
      'COUNT',
      ORDER_OUTBOX_BATCH_SIZE,
    )) as [string, StreamEntries];
    if (entries.length > 0) {
      this.logger.warn(
        `Reclaimed ${entries.length} order-outbox entr${entries.length === 1 ? 'y' : 'ies'} idle for over ${ORDER_OUTBOX_CLAIM_IDLE_MS}ms`,
      );
    }
    return entries.map(([id, fields]) => parseOrderOutboxEntry(id, fields));
  }

  // Entries already delivered to this consumer but never acknowledged
  private async readOwnPending(): Promise<OrderOutboxEntry[]> {
    const streams = await this.client.xreadgroup(
      'GROUP',
      ORDER_OUTBOX_GROUP,
      this.consumerName,
      'COUNT',
      ORDER_OUTBOX_BATCH_SIZE,
      'STREAMS',
      this.outboxKey,
      '0',
    );
    return parseStreams(streams);
  }

  private async readNew(): Promise<OrderOutboxEntry[]> {
    const streams = await this.client.xreadgroup(
      'GROUP',
      ORDER_OUTBOX_GROUP,
      this.consumerName,
      'COUNT',
      ORDER_OUTBOX_BATCH_SIZE,
      'BLOCK',
      ORDER_OUTBOX_BLOCK_MS,
      'STREAMS',
      this.outboxKey,
      '>',
    );
    return parseStreams(streams);
  }

  private async enqueue(entry: OrderOutboxEntry): Promise<boolean> {
    try {
      await this.orderQueueProducer.enqueuePersistOrder(
        entry.saleId,
        entry.userId,
        new Date(entry.timestamp),
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to enqueue persist-order job for sale ${entry.saleId}, user ${entry.userId}; ` +
          `outbox entry ${entry.id} left pending and will be retried on the next pass`,
        error,
      );
      return false;
    }
  }
}

function parseStreams(
  streams: [key: string, items: StreamEntries][] | null,
): OrderOutboxEntry[] {
  const entries = streams?.[0]?.[1] ?? [];
  return entries.map(([id, fields]) => parseOrderOutboxEntry(id, fields));
}

function dedupeById(entries: OrderOutboxEntry[]): OrderOutboxEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('BUSYGROUP');
}

function isNoGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NOGROUP');
}
