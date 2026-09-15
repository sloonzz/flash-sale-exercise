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
  PERSIST_ORDER_ATTEMPTS,
  REDIS_COMMAND_TIMEOUT_MS,
} from '../config/env.ts';
import { PrismaService } from '../prisma/prisma.service.ts';
import { REDIS_CLIENT } from '../redis/redis.constants.ts';
import {
  deadLetterFields,
  ORDER_OUTBOX_GROUP,
  ORDER_OUTBOX_KEY,
  OrderOutboxEntry,
  orderOutboxDeadLetterKey,
  parseOrderOutboxEntry,
} from './order-outbox.ts';
import { persistOrderBackoffDelay } from './persist-order-retry.ts';
import { persistOrders } from './persist-orders.ts';
import { PRUNE_OUTBOX_CONSUMERS_SCRIPT } from './prune-outbox-consumers-script.ts';

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
// XPENDING's extended form: one row per pending entry
type PendingRow = [
  id: string,
  consumer: string,
  idle: number,
  deliveries: number,
];
type FailedEntry = [entry: OrderOutboxEntry, error: Error];

export interface DrainResult {
  /** Entries read this pass (landed, left pending, or dead-lettered). */
  handled: number;
  /** How long to wait before the next pass: 0 unless a write failed. */
  backoffMs: number;
}

/**
 * Writes order-outbox entries to Postgres.
 *
 * Every cluster worker runs one, all in the same consumer group, so entries
 * are spread across workers and any number of them can run concurrently
 * without coordination. Each pass writes what it read as one batch; an entry
 * is acknowledged (and deleted from the stream) only after its Order row is
 * in Postgres. Until then it sits in the group's pending list, owned by this
 * consumer, and is retried:
 *   - by this drainer on its next pass, if the write failed or a blocking
 *     read timed out after Redis had already delivered the entry (the reply
 *     arrives late and nobody is listening for it);
 *   - by whichever drainer is alive, once it has been idle for
 *     ORDER_OUTBOX_CLAIM_IDLE_MS, if this process died holding it.
 * The Order insert skips duplicates, so at-least-once here is safe.
 *
 * A failed batch is retried entry by entry in the same pass, so one entry
 * that can never land (its sale was deleted, say) does not hold the rest of
 * the batch hostage. What still fails stays pending; the drainer backs off
 * (capped exponential, see persist-order-retry.ts) before its next pass. The
 * pending list's delivery counter is the per-entry attempt count: an entry
 * that has been delivered PERSIST_ORDER_ATTEMPTS times and still fails is
 * moved to the dead-letter stream, atomically with its ack.
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
  private readonly deadLetterKey: string;
  private groupReady = false;
  private consecutiveFailures = 0;
  private running = false;
  private loop: Promise<void> = Promise.resolve();
  private readonly stopping = new AbortController();

  constructor(
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(ORDER_OUTBOX_KEY) private readonly outboxKey: string,
    private readonly prisma: PrismaService,
  ) {
    this.client = redis.duplicate();
    this.client.on('error', (error) =>
      this.logger.error('Order outbox Redis connection error', error),
    );
    this.deadLetterKey = orderOutboxDeadLetterKey(outboxKey);
  }

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.stopping.abort();
    await this.loop;
    await this.removeOwnConsumer();
    await this.client.quit();
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const { backoffMs } = await this.drainOnce();
        if (backoffMs > 0) await this.pause(backoffMs);
      } catch (error) {
        // Redis wiped or unreachable: recreate the group on the next pass and
        // keep looping — the app stays up, entries wait in the stream.
        if (isNoGroupError(error)) this.groupReady = false;
        this.logger.error('Failed to drain the order outbox', error);
        await this.pause(ORDER_OUTBOX_ERROR_BACKOFF_MS);
      }
    }
  }

  // A wait that shutdown cuts short
  private async pause(ms: number): Promise<void> {
    await sleep(ms, undefined, { signal: this.stopping.signal }).catch(
      () => {},
    );
  }

  /**
   * One pass: retry what this consumer already holds, reclaim entries
   * stranded by a dead drainer, then read new ones, and write them all.
   */
  async drainOnce(): Promise<DrainResult> {
    await this.ensureGroup();

    const entries = dedupeById([
      ...(await this.readOwnPending()),
      ...(await this.claimStale()),
      ...(await this.readNew()),
    ]);
    if (entries.length === 0) return { handled: 0, backoffMs: 0 };

    const failed = await this.persist(entries);
    const failedIds = new Set(failed.map(([entry]) => entry.id));
    const landed = entries.filter((entry) => !failedIds.has(entry.id));
    if (landed.length > 0) await this.ack(landed);

    if (failed.length === 0) {
      this.consecutiveFailures = 0;
      return { handled: entries.length, backoffMs: 0 };
    }
    this.consecutiveFailures += 1;
    await this.retryOrDeadLetter(failed);
    return { handled: entries.length, backoffMs: this.backoffMs() };
  }

  // Capped so a drainer waiting out a backoff never leaves its pending
  // entries idle long enough for another drainer to mistake it for dead and
  // reclaim them (which would count as extra attempts against them).
  private backoffMs(): number {
    return Math.min(
      persistOrderBackoffDelay(this.consecutiveFailures),
      ORDER_OUTBOX_CLAIM_IDLE_MS / 2,
    );
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
    await this.pruneDeadConsumers();
  }

  private async pruneDeadConsumers(): Promise<void> {
    const removed = (await this.client.eval(
      PRUNE_OUTBOX_CONSUMERS_SCRIPT,
      1,
      this.outboxKey,
      ORDER_OUTBOX_GROUP,
      ORDER_OUTBOX_CLAIM_IDLE_MS,
      this.consumerName,
    )) as number;
    if (removed > 0) {
      this.logger.log(
        `Removed ${removed} dead order-outbox consumer${removed === 1 ? '' : 's'}`,
      );
    }
  }

  /**
   * Graceful shutdown: the loop has stopped, so nothing can be delivered to
   * this consumer any more. Delete it unless it still holds entries whose
   * write failed — DELCONSUMER would discard those; leaving the consumer
   * lets a live drainer reclaim them after ORDER_OUTBOX_CLAIM_IDLE_MS.
   */
  private async removeOwnConsumer(): Promise<void> {
    try {
      const pending = await this.client.xpending(
        this.outboxKey,
        ORDER_OUTBOX_GROUP,
        '-',
        '+',
        1,
        this.consumerName,
      );
      if (pending.length > 0) return;
      await this.client.xgroup(
        'DELCONSUMER',
        this.outboxKey,
        ORDER_OUTBOX_GROUP,
        this.consumerName,
      );
    } catch (error) {
      // Best effort: a leftover consumer is pruned by a live drainer later.
      this.logger.warn('Failed to remove own order-outbox consumer', error);
    }
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

  /**
   * One write for the whole batch; if that fails, one write per entry so a
   * single bad entry cannot fail the others. Returns the entries that did
   * not land, with what they failed on.
   */
  private async persist(entries: OrderOutboxEntry[]): Promise<FailedEntry[]> {
    try {
      await persistOrders(this.prisma, entries);
      return [];
    } catch (error) {
      if (entries.length === 1) return [[entries[0], toError(error)]];
    }
    const results = await Promise.allSettled(
      entries.map((entry) => persistOrders(this.prisma, [entry])),
    );
    return results.flatMap((result, i) =>
      result.status === 'rejected'
        ? [[entries[i], toError(result.reason)] as FailedEntry]
        : [],
    );
  }

  private async ack(entries: OrderOutboxEntry[]): Promise<void> {
    const ids = entries.map(({ id }) => id);
    await this.client
      .multi()
      .xack(this.outboxKey, ORDER_OUTBOX_GROUP, ...ids)
      .xdel(this.outboxKey, ...ids)
      .exec();
  }

  /**
   * Failed entries stay pending to be retried next pass, except those that
   * have used up their attempts: those move to the dead-letter stream in the
   * same transaction that acks them, so an entry is always in exactly one of
   * the two.
   */
  private async retryOrDeadLetter(failed: FailedEntry[]): Promise<void> {
    const attempts = await this.deliveryCounts(
      failed.map(([entry]) => entry.id),
    );
    const exhausted: [OrderOutboxEntry, number, Error][] = [];

    for (const [entry, error] of failed) {
      const made = attempts.get(entry.id);
      if (made !== undefined && made >= PERSIST_ORDER_ATTEMPTS) {
        exhausted.push([entry, made, error]);
        continue;
      }
      this.logger.error(
        `Failed to persist Order for sale ${entry.saleId}, user ${entry.userId} ` +
          `(attempt ${made ?? '?'} of ${PERSIST_ORDER_ATTEMPTS}); ` +
          `outbox entry ${entry.id} left pending and will be retried`,
        error,
      );
    }
    if (exhausted.length === 0) return;

    const multi = this.client.multi();
    for (const [entry, made, error] of exhausted) {
      multi.xadd(
        this.deadLetterKey,
        '*',
        ...deadLetterFields(entry, made, error.message),
      );
    }
    const ids = exhausted.map(([entry]) => entry.id);
    await multi
      .xack(this.outboxKey, ORDER_OUTBOX_GROUP, ...ids)
      .xdel(this.outboxKey, ...ids)
      .exec();

    for (const [entry, made, error] of exhausted) {
      this.logger.error(
        `Order for sale ${entry.saleId}, user ${entry.userId} DEAD-LETTERED after ${made} attempts: ` +
          `the user holds a Reservation with no Order. Moved to ${this.deadLetterKey} and will not be ` +
          `retried automatically — needs manual intervention (OrderOutboxService.replayDeadLettered).`,
        error,
      );
    }
  }

  // How many times each entry has been delivered to a consumer, from the
  // group's pending list — Redis counts every read of it, so it is the
  // attempt count even across drainers.
  private async deliveryCounts(ids: string[]): Promise<Map<string, number>> {
    const pipeline = this.client.pipeline();
    for (const id of ids) {
      pipeline.xpending(this.outboxKey, ORDER_OUTBOX_GROUP, id, id, 1);
    }
    const replies = (await pipeline.exec()) ?? [];
    const counts = new Map<string, number>();
    replies.forEach(([error, rows], i) => {
      const row = (rows as PendingRow[] | null)?.[0];
      if (!error && row) counts.set(ids[i], row[3]);
    });
    return counts;
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

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('BUSYGROUP');
}

function isNoGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NOGROUP');
}
