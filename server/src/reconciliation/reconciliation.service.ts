import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { RECONCILE_SALES_WINDOW_MS } from '../config/env.ts';
import { OrderQueueProducer } from '../order/order-queue.producer.ts';
import { PrismaService } from '../prisma/prisma.service.ts';
import { ReservationService } from '../reservation/reservation.service.ts';

/**
 * Service for handling failures in-between the services: DB, backend, Queue
 * This service reconciles the data between the three
 */
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
      await this.reconcileAllSales();
    } catch (error) {
      this.logger.error('Failed to reconcile sales on startup', error);
    }
  }

  // Bounded by end time so startup cost doesn't grow with the whole sales table
  async reconcileAllSales(): Promise<void> {
    const sales = await this.prisma.sale.findMany({
      where: {
        endTime: { gte: new Date(Date.now() - RECONCILE_SALES_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    for (const sale of sales) {
      try {
        await this.reconcile(sale.id);
      } catch (error) {
        this.logger.error(`Failed to reconcile sale ${sale.id}`, error);
      }
    }
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

    // IMPORTANT: Seed first before initializing stock so we don't decrease stock for an already-reserved user
    (await this.reservationService.seedReservedUsers(
      saleId,
      orders.map((order) => order.userId),
    ),
      await this.reservationService.initializeStock(saleId, stock),
      await this.requeueOrphanedReservations(
        saleId,
        new Set(orders.map((order) => order.userId)),
      ));
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

    const deadLettered = new Set(
      await this.orderQueueProducer.listDeadLettered(saleId),
    );
    if (deadLettered.size > 0) {
      this.logger.error(
        `${deadLettered.size} dead-lettered persist-order job(s) for sale ${saleId} left in 'failed' — needs manual intervention`,
      );
    }

    const toEnqueue = orphaned.filter((userId) => !deadLettered.has(userId));
    if (toEnqueue.length === 0) {
      return;
    }

    const timestamp = new Date();
    await Promise.all(
      toEnqueue.map((userId) =>
        this.orderQueueProducer.enqueuePersistOrder(saleId, userId, timestamp),
      ),
    );
    this.logger.warn(
      `Re-enqueued ${toEnqueue.length} persist-order job(s) for sale ${saleId} whose Reservations had no Order`,
    );
  }
}
