import type { IncomingMessage } from 'node:http';
import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseFilters } from '@nestjs/common';
import { controlCursorPage, controlEmptyBody, controlResourceId } from '@nventra/types';
import type { z } from 'zod';
import { StaffAuth } from '../staff/staff-auth.js';
import { sessionCookie, StaffExceptionFilter } from '../staff/staff.controller.js';
import { PortalAccounts } from './portal-accounts.js';
import { PortalAuth } from './portal-auth.js';
import { portalAccountInput } from './portal-identity-policy.js';

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}

@Controller('businesses/:id/portal-accounts')
@UseFilters(StaffExceptionFilter)
export class PortalAccountsController {
  private readonly accounts: PortalAccounts;
  constructor(@Inject(StaffAuth) staff: StaffAuth, @Inject(PortalAuth) portal: PortalAuth) {
    this.accounts = new PortalAccounts(staff.access, portal);
  }

  @Get()
  list(@Req() req: IncomingMessage, @Param('id') id: string, @Query() query: unknown) {
    return this.accounts.list(sessionCookie(req), input(controlResourceId, id), input(controlCursorPage, query));
  }

  @Post()
  provision(@Req() req: IncomingMessage, @Param('id') id: string, @Body() body: unknown) {
    return this.accounts.change(sessionCookie(req), input(controlResourceId, id), { kind: 'provision', ...input(portalAccountInput, body) });
  }

  private change(req: IncomingMessage, id: string, accountId: string, body: unknown, kind: 'reissue' | 'revoke') {
    input(controlEmptyBody, body ?? {});
    return this.accounts.change(sessionCookie(req), input(controlResourceId, id), { kind, accountId: input(controlResourceId, accountId) });
  }

  @Post(':accountId/reissue') @HttpCode(200)
  reissue(@Req() req: IncomingMessage, @Param('id') id: string, @Param('accountId') accountId: string, @Body() body: unknown) {
    return this.change(req, id, accountId, body, 'reissue');
  }

  @Post(':accountId/revoke') @HttpCode(200)
  revoke(@Req() req: IncomingMessage, @Param('id') id: string, @Param('accountId') accountId: string, @Body() body: unknown) {
    return this.change(req, id, accountId, body, 'revoke');
  }
}
