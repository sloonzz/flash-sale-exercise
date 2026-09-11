import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  purchaseBodySchema,
  saleIdSchema,
  userIdSchema,
  type PurchaseBody,
  type PurchaseResponse,
  type SecuredResponse,
} from 'common';
import { ZodValidationPipe } from '../common/zod-validation.pipe.ts';
import { SaleService } from './sale.service.ts';

@Controller('purchase')
export class PurchaseController {
  constructor(private readonly saleService: SaleService) {}

  @Post()
  @UseGuards(ThrottlerGuard)
  async purchase(
    @Body(new ZodValidationPipe(purchaseBodySchema)) body: PurchaseBody,
  ): Promise<PurchaseResponse> {
    const result = await this.saleService.purchase(body.userId, body.saleId);
    return { result };
  }

  @Get(':saleId')
  async checkSecured(
    @Param('saleId', new ZodValidationPipe(saleIdSchema)) saleId: string,
    @Headers('x-user-id') rawUserId: string,
  ): Promise<SecuredResponse> {
    const userId = new ZodValidationPipe(userIdSchema).transform(rawUserId);
    const secured = await this.saleService.hasSecured(userId, saleId);
    return { secured };
  }
}
