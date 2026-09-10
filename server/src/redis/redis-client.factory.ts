import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_URL } from '../config/env.ts';

export function createRedisClient(): Redis {
  const logger = new Logger('RedisModule');
  const client = new Redis(REDIS_URL);
  // An unhandled 'error' event on an ioredis connection crashes the
  // process; a connection blip must not take down the API. Owning this
  // here means every consumer of REDIS_CLIENT gets it for free.
  client.on('error', (error) => logger.error('Redis connection error', error));
  return client;
}
