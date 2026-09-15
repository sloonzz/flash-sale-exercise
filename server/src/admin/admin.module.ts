import { Module } from '@nestjs/common';
import { SaleModule } from '../sale/sale.module.ts';
import { AdminAuthController } from './admin-auth.controller.ts';
import { AdminController } from './admin.controller.ts';
import { AdminKeyGuard } from './admin-key.guard.ts';

@Module({
  imports: [SaleModule],
  controllers: [AdminController, AdminAuthController],
  providers: [AdminKeyGuard],
})
export class AdminModule {}
