import type { IncomingMessage } from 'node:http';
import { BadRequestException, Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseFilters } from '@nestjs/common';
import { controlResourceId, ticketListPage, ticketMessagePage, ticketNote, ticketPatch } from '@nventra/types';
import type { z } from 'zod';
import { StaffAuth } from '../../staff/staff-auth.js';
import { sessionCookie, StaffExceptionFilter } from '../../staff/staff.controller.js';
import { TicketService } from './tickets.js';

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}

@Controller('tickets')
@UseFilters(StaffExceptionFilter)
export class TicketsController {
  private readonly tickets: TicketService;
  constructor(@Inject(StaffAuth) auth: StaffAuth) { this.tickets = new TicketService(auth.access); }

  @Get()
  list(@Req() req: IncomingMessage, @Query() query: unknown) {
    return this.tickets.list(sessionCookie(req), input(ticketListPage, query));
  }

  @Get(':id')
  detail(@Req() req: IncomingMessage, @Param('id') id: string, @Query() query: unknown) {
    return this.tickets.detail(sessionCookie(req), input(controlResourceId, id), input(ticketMessagePage, query));
  }

  @Patch(':id')
  update(@Req() req: IncomingMessage, @Param('id') id: string, @Body() body: unknown) {
    return this.tickets.update(sessionCookie(req), input(controlResourceId, id), input(ticketPatch, body));
  }

  @Post(':id/notes')
  addNote(@Req() req: IncomingMessage, @Param('id') id: string, @Body() body: unknown) {
    return this.tickets.addNote(sessionCookie(req), input(controlResourceId, id), input(ticketNote, body));
  }
}
