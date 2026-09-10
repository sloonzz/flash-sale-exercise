import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisModule } from './redis.module.ts';

describe('RedisModule', () => {
  const mockClient = { quit: vi.fn() } as unknown as Redis;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes its Redis connection on module destroy', async () => {
    const redisModule = new RedisModule(mockClient);

    await redisModule.onModuleDestroy();

    expect(mockClient.quit).toHaveBeenCalled();
  });
});
