import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_COMMAND_TIMEOUT_MS, REDIS_URL } from '../config/env.ts';

export function createRedisClient(): Redis {
  const logger = new Logger('RedisModule');
  const client = new Redis(REDIS_URL, {
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  });
  client.on('error', (error) => logger.error('Redis connection error', error));
  return client;
}
