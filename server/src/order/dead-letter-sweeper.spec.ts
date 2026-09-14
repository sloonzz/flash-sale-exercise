import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.ts';
import {
  DeadLetterSweeper,
  DLQ_SWEEP_LEASE_KEY,
} from './dead-letter-sweeper.ts';
import { OrderQueueProducer } from './order-queue.producer.ts';

describe('DeadLetterSweeper', () => {
  const redis = { set: vi.fn() } as unknown as Redis;
  const prisma = { $queryRaw: vi.fn() } as unknown as PrismaService;
  const producer = {
    countDeadLettered: vi.fn(),
    retryDeadLettered: vi.fn(),
  } as unknown as OrderQueueProducer;
  const sweeper = new DeadLetterSweeper(redis, prisma, producer, 5_000);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.mocked(redis.set).mockResolvedValue('OK');
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ '?column?': 1 }]);
    vi.mocked(producer.retryDeadLettered).mockResolvedValue(['user-1']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing beyond a count when nothing is dead-lettered', async () => {
    vi.mocked(producer.countDeadLettered).mockResolvedValue(0);

    await expect(sweeper.sweep()).resolves.toEqual([]);

    expect(redis.set).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(producer.retryDeadLettered).not.toHaveBeenCalled();
  });

  it('takes a lease that lasts one interval, then retries when Postgres answers', async () => {
    vi.mocked(producer.countDeadLettered).mockResolvedValue(2);

    await expect(sweeper.sweep()).resolves.toEqual(['user-1']);

    expect(redis.set).toHaveBeenCalledWith(
      DLQ_SWEEP_LEASE_KEY,
      process.pid,
      'PX',
      5_000,
      'NX',
    );
    expect(producer.retryDeadLettered).toHaveBeenCalledWith();
  });

  it('stands down when another replica holds the lease', async () => {
    vi.mocked(producer.countDeadLettered).mockResolvedValue(2);
    vi.mocked(redis.set).mockResolvedValue(null as any);

    await expect(sweeper.sweep()).resolves.toEqual([]);

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(producer.retryDeadLettered).not.toHaveBeenCalled();
  });

  it('leaves jobs dead-lettered while Postgres is still unreachable', async () => {
    vi.mocked(producer.countDeadLettered).mockResolvedValue(2);
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(sweeper.sweep()).resolves.toEqual([]);

    expect(producer.retryDeadLettered).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('Postgres still unreachable'),
    );
  });

  it('never throws out of the timer callback', async () => {
    vi.mocked(producer.countDeadLettered).mockRejectedValue(
      new Error('redis down'),
    );

    await expect(sweeper.sweep()).resolves.toEqual([]);
    expect(Logger.prototype.error).toHaveBeenCalled();
  });

  it('does not start a timer when disabled', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const disabled = new DeadLetterSweeper(redis, prisma, producer, 0);

    disabled.onApplicationBootstrap();
    disabled.onApplicationShutdown();

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
