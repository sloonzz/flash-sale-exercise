import { PrismaService } from '../prisma/prisma.service.ts';
import { PersistOrderJobData } from './persist-order-job.ts';

// Upsert, not create: a job retried after a crash between the Postgres write
// and the BullMQ ack must land without throwing on the unique constraint.
export async function persistOrder(
  prisma: PrismaService,
  data: PersistOrderJobData,
): Promise<void> {
  await prisma.order.upsert({
    where: { saleId_userId: { saleId: data.saleId, userId: data.userId } },
    create: {
      saleId: data.saleId,
      userId: data.userId,
      createdAt: new Date(data.timestamp),
    },
    update: {},
  });
}
