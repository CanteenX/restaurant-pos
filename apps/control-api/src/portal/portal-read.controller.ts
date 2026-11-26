import type { IncomingMessage, ServerResponse } from 'node:http';
import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Query, Req, Res, StreamableFile, UseFilters } from '@nestjs/common';
import { controlCursorPage, controlEmptyBody, controlResourceId } from '@nventra/types';
import type { z } from 'zod';
import type { Prisma } from '../../node_modules/.prisma/control-client/index.js';
import { portalInvoices, portalPayments } from './portal-billing.js';
import { StaffExceptionFilter } from '../staff/staff.controller.js';
import { PortalAuth, type PortalPrincipal } from './portal-auth.js';
import { portalTokenFromRequest } from './portal-auth.controller.js';
import { isPortalDownload, PortalDownloads, type PortalFile, type readPortalResources } from './portal-downloads.js';
import { portalBusiness, portalOutlets } from './portal-read.js';

export const portalResourceConfig = Symbol('portalResourceConfig');
type Config = ReturnType<typeof readPortalResources>;
type Business = Awaited<ReturnType<typeof portalBusiness>>;

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}

@Controller('portal')
@UseFilters(StaffExceptionFilter)
export class PortalReadController {
  private readonly files: PortalDownloads;
  constructor(@Inject(PortalAuth) private readonly auth: PortalAuth,
    @Inject(portalResourceConfig) private readonly config: Config) {
    this.files = new PortalDownloads(config.directory);
  }

  private use<T>(req: IncomingMessage, paid: boolean, work: (tx: Prisma.TransactionClient, business: Business) => Promise<T>) {
    return this.auth.withSession(portalTokenFromRequest(req), async (tx, principal) =>
      work(tx, await portalBusiness(tx, principal.businessId, paid)));
  }

  @Get('summary')
  summary(@Req() req: IncomingMessage, @Query() query: unknown) {
    input(controlEmptyBody, query);
    return this.use(req, false, (_tx, { id, displayName, hostedStatus }) => Promise.resolve({
      business: { id, displayName }, hostedStatus, supportEmail: this.config.supportEmail,
      paymentInstructions: this.config.paymentInstructions
    }));
  }

  @Get('invoices')
  invoices(@Req() req: IncomingMessage, @Query() query: unknown) {
    const page = input(controlCursorPage, query);
    return this.use(req, false, (tx, business) => portalInvoices(tx, business.id, page));
  }

  @Get('invoices/:id/payments')
  payments(@Req() req: IncomingMessage, @Param('id') id: string, @Query() query: unknown) {
    const page = input(controlCursorPage, query), invoiceId = input(controlResourceId, id);
    return this.use(req, false, (tx, business) => portalPayments(tx, business.id, invoiceId, page));
  }

  @Get('outlets')
  outlets(@Req() req: IncomingMessage, @Query() query: unknown) {
    const page = input(controlCursorPage, query);
    return this.use(req, true, (tx, business) => portalOutlets(tx, business.id, page));
  }

  @Get('downloads')
  downloads(@Req() req: IncomingMessage, @Query() query: unknown) {
    input(controlEmptyBody, query);
    return this.use(req, true, async () => ({ items: await this.files.list() }));
  }

  @Get('downloads/:id')
  async download(@Req() req: IncomingMessage, @Param('id') id: string, @Query() query: unknown,
    @Res({ passthrough: true }) res: ServerResponse) {
    input(controlEmptyBody, query);
    let opened: PortalFile | null = null;
    const open = async (tx: Prisma.TransactionClient, { businessId }: PortalPrincipal) => {
      if (!isPortalDownload(id)) throw new NotFoundException();
      await portalBusiness(tx, businessId, true);
      opened = await this.files.open(id);
      if (!opened) throw new NotFoundException();
      return opened;
    };
    try {
      const { handle, length, name } = await this.auth.withSession(portalTokenFromRequest(req), open);
      const stream = handle.createReadStream();
      if (res.destroyed) stream.destroy();
      else res.once('close', () => stream.destroy());
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return new StreamableFile(stream, { type: 'application/octet-stream', length,
        disposition: 'attachment; filename="' + name + '"' });
    } catch (error) {
      // A failed database commit can occur after the callback acquired a file.
      await (opened as PortalFile | null)?.handle.close();
      throw error;
    }
  }
}
