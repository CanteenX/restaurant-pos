import type { IncomingMessage } from 'node:http';
import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, UseFilters } from '@nestjs/common';
import { controlCursorPage, controlResourceId, ticketMessagePage } from '@nventra/types';
import { portalTicketOpen, portalTicketStaffReply } from '@nventra/types/dist/control-portal-ticket';
import type { z } from 'zod';
import { PortalAuth } from '../../portal/portal-auth.js';
import { portalTokenFromRequest } from '../../portal/portal-auth.controller.js';
import { portalBusiness } from '../../portal/portal-read.js';
import { StaffAuth } from '../../staff/staff-auth.js';
import { sessionCookie, StaffExceptionFilter } from '../../staff/staff.controller.js';
import { listPortalTickets, openPortalTicket, publishPortalReply, readPortalTicket } from './portal-ticket-store.js';

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}

@Controller('portal/tickets')
@UseFilters(StaffExceptionFilter)
export class PortalTicketsController {
  constructor(@Inject(PortalAuth) private readonly auth: PortalAuth) {}

  @Get()
  list(@Req() req: IncomingMessage, @Query() query: unknown) {
    const page = input(controlCursorPage, query);
    return this.auth.withSession(portalTokenFromRequest(req), async (tx, { businessId }) => {
      await portalBusiness(tx, businessId, true);
      return listPortalTickets(tx, page);
    });
  }

  @Get(':id')
  detail(@Req() req: IncomingMessage, @Param('id') rawId: string, @Query() query: unknown) {
    const id = input(controlResourceId, rawId);
    const page = input(ticketMessagePage, query);
    return this.auth.withSession(portalTokenFromRequest(req), async (tx, { businessId }) => {
      await portalBusiness(tx, businessId, true);
      return readPortalTicket(tx, id, page);
    });
  }

  @Post()
  open(@Req() req: IncomingMessage, @Body() body: unknown) {
    const draft = input(portalTicketOpen, body);
    return this.auth.withSession(portalTokenFromRequest(req), async (tx, { businessId }) => {
      await portalBusiness(tx, businessId, true);
      return openPortalTicket(tx, draft);
    });
  }
}

@Controller('tickets')
@UseFilters(StaffExceptionFilter)
export class PortalTicketReplyController {
  constructor(@Inject(StaffAuth) private readonly auth: StaffAuth) {}

  @Post(':id/portal-replies')
  reply(@Req() req: IncomingMessage, @Param('id') rawId: string, @Body() body: unknown) {
    const id = input(controlResourceId, rawId);
    const draft = input(portalTicketStaffReply, body);
    return this.auth.access.withPermission(sessionCookie(req), 'cc.ticket.reply',
      (tx, actor) => publishPortalReply(tx, id, actor.id, draft));
  }
}
