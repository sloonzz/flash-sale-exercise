import 'dotenv/config';
import cluster from 'node:cluster';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';

const CLUSTER_WORKERS = Number(process.env.CLUSTER_WORKERS ?? 1);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  const server = await app.listen(process.env.PORT ?? 3000);
  const address = server.address();
  const port = typeof address === 'string' ? address : address?.port;
  process.send?.({ ready: true, port });
}

if (CLUSTER_WORKERS > 1 && cluster.isPrimary) {
  const workers = Array.from({ length: CLUSTER_WORKERS }, () => cluster.fork());

  let readyCount = 0;
  for (const worker of workers) {
    worker.on('message', (message: { ready?: boolean; port?: number }) => {
      if (!message.ready) return;
      readyCount++;
      if (readyCount === CLUSTER_WORKERS) {
        process.send?.({ ready: true, port: message.port });
      }
    });
  }

  process.on('SIGTERM', () => {
    for (const worker of workers) worker.kill();
    process.exit(0);
  });
} else {
  await bootstrap();
}
