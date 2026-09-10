import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_URL } from '../config/env.ts';

export function createRedisClient(): Redis {
  const logger = new Logger('RedisModule');
  const client = new Redis(REDIS_URL);
  client.on('error', (error) => logger.error('Redis connection error', error));
  return client;
}
