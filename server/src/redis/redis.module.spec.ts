import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisModule } from './redis.module.ts';

describe('RedisModule', () => {
  const mockClient = { quit: vi.fn() } as unknown as Redis;
  const mockThrottleClient = { quit: vi.fn() } as unknown as Redis;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes both Redis connections on module destroy', async () => {
    const redisModule = new RedisModule(mockClient, mockThrottleClient);

    await redisModule.onModuleDestroy();

    expect(mockClient.quit).toHaveBeenCalled();
    expect(mockThrottleClient.quit).toHaveBeenCalled();
  });
});
