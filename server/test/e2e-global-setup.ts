import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { parse } from 'dotenv';
import { Redis } from 'ioredis';
import { PrismaClient } from '../src/generated/prisma/client.ts';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Wipes the dedicated e2e database and Redis logical DB before the suite
// runs, so results never depend on what a previous run (or manual testing
// against the dev database) left behind.
export default async function setup() {
  const env = parse(fs.readFileSync(path.resolve(dirname, '../.env.e2e')));

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "orders", "sales" RESTART IDENTITY CASCADE',
  );
  await prisma.$disconnect();

  const redis = new Redis(env.REDIS_URL);
  await redis.flushdb();
  await redis.quit();
}
