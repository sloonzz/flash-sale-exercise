import { Module } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service.js';

@Module({
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
