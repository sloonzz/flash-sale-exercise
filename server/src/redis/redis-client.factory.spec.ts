import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  });

  it('connects to the configured Redis URL', async () => {
    const { createRedisClient } = await import('./redis-client.factory.ts');

    createRedisClient();

    expect(RedisMock).toHaveBeenCalledWith('redis://localhost:6379');
  });

  it('registers an error listener so a connection blip cannot crash the process', async () => {
    const { createRedisClient } = await import('./redis-client.factory.ts');

    createRedisClient();

    expect(mockRedis.on).toHaveBeenCalledWith('error', expect.any(Function));
    const [, onError] = mockRedis.on.mock.calls[0];
    expect(() => onError(new Error('connection reset'))).not.toThrow();
  });
});
