import { Module } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service.ts';

@Module({
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
