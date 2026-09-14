import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class AdminKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const providedKey = request.headers['x-admin-key'];

    if (!providedKey) {
      throw new UnauthorizedException('Missing x-admin-key header');
    }

    if (!process.env.ADMIN_KEY || providedKey !== process.env.ADMIN_KEY) {
      throw new ForbiddenException('Invalid x-admin-key header');
    }

    return true;
  }
}
