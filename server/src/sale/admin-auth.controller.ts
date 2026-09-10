import { Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AdminLoginResponse } from 'common';
import { AdminKeyGuard } from './admin-key.guard.ts';

@Controller('admin')
export class AdminAuthController {
  @Post('login')
  @UseGuards(ThrottlerGuard, AdminKeyGuard)
  login(@Headers('x-admin-key') adminKey: string): AdminLoginResponse {
    return { adminKey };
  }
}
