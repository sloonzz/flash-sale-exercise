import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminKeyGuard } from './admin-key.guard.ts';

describe('AdminKeyGuard', () => {
  const guard = new AdminKeyGuard();
  const originalAdminKey = process.env.ADMIN_KEY;

  function contextWithHeader(
    headerValue: string | undefined,
  ): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'x-admin-key': headerValue } }),
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    process.env.ADMIN_KEY = 'the-real-key';
  });

  afterEach(() => {
    process.env.ADMIN_KEY = originalAdminKey;
  });

  it('allows a request with the matching x-admin-key header', () => {
    expect(guard.canActivate(contextWithHeader('the-real-key'))).toBe(true);
  });

  it('rejects with 401 when the header is missing', () => {
    expect(() => guard.canActivate(contextWithHeader(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects with 403 when the header does not match', () => {
    expect(() => guard.canActivate(contextWithHeader('wrong-key'))).toThrow(
      ForbiddenException,
    );
  });
});
