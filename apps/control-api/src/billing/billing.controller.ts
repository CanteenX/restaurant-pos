import type { IncomingMessage } from 'node:http';
import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, UseFilters } from '@nestjs/common';
import { controlCursorPage, controlResourceId } from '@nventra/types';
import { billingInvoiceInput, billingPaymentInput } from '@nventra/types/dist/control-billing';
import type { z } from 'zod';
import { StaffAuth } from '../staff/staff-auth.js';
import { sessionCookie, StaffExceptionFilter } from '../staff/staff.controller.js';
import { issueInvoice, listBusinessInvoices, listInvoicePayments, listOverdueInvoices, recordPayment } from './billing.js';

const overduePage = controlCursorPage.extend({ businessId: controlResourceId.optional() });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException();
  return result.data;
}

@Controller()
@UseFilters(StaffExceptionFilter)
export class BillingController {
  constructor(@Inject(StaffAuth) private readonly auth: StaffAuth) { }

  @Get('businesses/:id/invoices')
  invoices(@Req() req: IncomingMessage, @Param('id') id: string, @Query() query: unknown) {
    return this.auth.access.withPermission(sessionCookie(req), 'cc.billing.read', tx =>
      listBusinessInvoices(tx, parse(controlResourceId, id), parse(controlCursorPage, query)));
  }

  @Post('businesses/:id/invoices')
  issue(@Req() req: IncomingMessage, @Param('id') id: string, @Body() body: unknown) {
    return this.auth.access.withPermission(sessionCookie(req), 'cc.billing.manage', (tx, actor) =>
      issueInvoice(tx, parse(controlResourceId, id), actor.id, parse(billingInvoiceInput, body)), { recent: true });
  }

  @Get('businesses/:id/invoices/:invoiceId/payments')
  payments(@Req() req: IncomingMessage, @Param('id') id: string, @Param('invoiceId') invoiceId: string, @Query() query: unknown) {
    return this.auth.access.withPermission(sessionCookie(req), 'cc.billing.read', tx =>
      listInvoicePayments(tx, parse(controlResourceId, id), parse(controlResourceId, invoiceId), parse(controlCursorPage, query)));
  }

  @Post('businesses/:id/invoices/:invoiceId/payments')
  pay(@Req() req: IncomingMessage, @Param('id') id: string, @Param('invoiceId') invoiceId: string, @Body() body: unknown) {
    return this.auth.access.withPermission(sessionCookie(req), 'cc.billing.manage', (tx, actor) =>
      recordPayment(tx, parse(controlResourceId, id), parse(controlResourceId, invoiceId), actor.id, parse(billingPaymentInput, body)), { recent: true });
  }

  @Get('billing/overdue')
  overdue(@Req() req: IncomingMessage, @Query() query: unknown) {
    return this.auth.access.withPermission(sessionCookie(req), 'cc.billing.read', tx => {
      const page = parse(overduePage, query);
      return listOverdueInvoices(tx, page, page.businessId);
    });
  }
}
