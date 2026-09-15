import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedis, RedisMock } = vi.hoisted(() => {
  const mockRedis = { on: vi.fn() };
  return {
    mockRedis,
    RedisMock: vi.fn().mockImplementation(function RedisMock() {
      return mockRedis;
    }),
  };
});

vi.mock('ioredis', () => ({ Redis: RedisMock }));

describe('createRedisClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('connects to the configured Redis URL with a bounded command timeout', async () => {
    const { createRedisClient } = await import('./redis-client.factory.ts');

    createRedisClient();

    expect(RedisMock).toHaveBeenCalledWith('redis://localhost:6379', {
      commandTimeout: 3000,
    });
  });

  it('registers an error listener so a connection blip cannot crash the process', async () => {
    const { createRedisClient } = await import('./redis-client.factory.ts');

    createRedisClient();

    expect(mockRedis.on).toHaveBeenCalledWith('error', expect.any(Function));
    const [, onError] = mockRedis.on.mock.calls[0];
    expect(() => onError(new Error('connection reset'))).not.toThrow();
  });
});

describe('createThrottleRedisClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('opens its own connection to the main Redis when THROTTLE_REDIS_URL is unset', async () => {
    const { createRedisClient, createThrottleRedisClient } =
      await import('./redis-client.factory.ts');

    createRedisClient();
    createThrottleRedisClient();

    expect(RedisMock).toHaveBeenCalledTimes(2);
    expect(RedisMock).toHaveBeenNthCalledWith(2, 'redis://localhost:6379', {
      commandTimeout: 3000,
    });
  });

  it('connects to THROTTLE_REDIS_URL when set', async () => {
    vi.stubEnv('THROTTLE_REDIS_URL', 'redis://throttle:6380');
    const { createThrottleRedisClient } =
      await import('./redis-client.factory.ts');

    createThrottleRedisClient();

    expect(RedisMock).toHaveBeenCalledWith('redis://throttle:6380', {
      commandTimeout: 3000,
    });
  });
});
