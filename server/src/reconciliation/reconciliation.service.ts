import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { OrderQueueProducer } from '../order/order-queue.producer.ts';
import { PrismaService } from '../prisma/prisma.service.ts';
import { ReservationService } from '../reservation/reservation.service.ts';

@Injectable()
export class ReconciliationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationService: ReservationService,
    private readonly orderQueueProducer: OrderQueueProducer,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.reconcileCurrentSale();
    } catch (error) {
      this.logger.error(
        'Failed to reconcile the current sale on startup',
        error,
      );
    }
  }

  async reconcileCurrentSale(): Promise<void> {
    const sale = await this.prisma.sale.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!sale) {
      return;
    }
    await this.reconcile(sale.id);
  }

  async reconcile(saleId: string): Promise<void> {
    const [sale, orders] = await Promise.all([
      this.prisma.sale.findUniqueOrThrow({ where: { id: saleId } }),
      this.prisma.order.findMany({
        where: { saleId },
        select: { userId: true },
      }),
    ]);

    const stock = sale.totalStock - orders.length;

    await Promise.all([
      this.reservationService.initializeStock(saleId, stock),
      this.reservationService.seedReservedUsers(
        saleId,
        orders.map((order) => order.userId),
      ),
    ]);

    await this.requeueOrphanedReservations(
      saleId,
      new Set(orders.map((order) => order.userId)),
    );
  }

  private async requeueOrphanedReservations(
    saleId: string,
    orderedUserIds: Set<string>,
  ): Promise<void> {
    const reservedUserIds =
      await this.reservationService.getReservedUsers(saleId);
    const orphaned = reservedUserIds.filter(
      (userId) => !orderedUserIds.has(userId),
    );
    if (orphaned.length === 0) {
      return;
    }

    const timestamp = new Date();
    await Promise.all(
      orphaned.map((userId) =>
        this.orderQueueProducer.enqueuePersistOrder(saleId, userId, timestamp),
      ),
    );
    this.logger.warn(
      `Re-enqueued ${orphaned.length} persist-order job(s) for sale ${saleId} whose Reservations had no Order`,
    );
  }
}
