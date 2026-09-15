import { PrismaService } from '../../../prisma/prisma.service.ts';
import { OrderOutboxEntry } from '../order-outbox.ts';

// One INSERT for the whole batch. Skip duplicates, not fail: an entry retried
// after a crash between the Postgres write and the outbox ack must land
// without throwing on the unique constraint.
export async function persistOrders(
  prisma: PrismaService,
  entries: OrderOutboxEntry[],
): Promise<void> {
  await prisma.order.createMany({
    data: entries.map((entry) => ({
      saleId: entry.saleId,
      userId: entry.userId,
      createdAt: new Date(entry.timestamp),
    })),
    skipDuplicates: true,
  });
}
