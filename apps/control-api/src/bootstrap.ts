import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { readControlPort, readStaffConfig } from './config.js';
import { StaffAuth } from './staff/staff-auth.js';
import { AuditReadController } from './audit/audit-read.controller.js';
import { BillingController } from './billing/billing.controller.js';
import { BusinessController } from './business/business.controller.js';
import { HostedAccessController } from './hosted/hosted-access.controller.js';
import { PlansController } from './plans/plans.controller.js';
import { PortalAccountsController } from './portal/portal-accounts.controller.js';
import { PortalAuthController } from './portal/portal-auth.controller.js';
import { PortalAuth } from './portal/portal-auth.js';
import { readPortalResources } from './portal/portal-downloads.js';
import { PortalReadController, portalResourceConfig } from './portal/portal-read.controller.js';
import { readPortalConfig } from './portal/portal-identity-policy.js';
import { TicketsController } from './helpdesk/tickets/tickets.controller.js';
import { PortalTicketReplyController, PortalTicketsController } from './helpdesk/portal/portal-tickets.controller.js';
import { StaffController } from './staff/staff.controller.js';

@Controller('health')
class HealthController {
  @Get()
  health() { return { status: 'ok' }; }
}

/** Staff-authenticated controllers; the route inventory test derives its route list from these. */
export const staffControllers = [StaffController, BusinessController, PlansController, TicketsController,
  AuditReadController, BillingController, HostedAccessController, PortalTicketReplyController] as const;
/** Controllers that exist only when the customer portal is configured. */
export const portalControllers = [PortalAccountsController, PortalAuthController, PortalReadController,
  PortalTicketsController] as const;

@Module({ controllers: [HealthController] })
class ControlApiModule {}

export async function createControlApi(env: NodeJS.ProcessEnv) {
  const port = readControlPort(env);
  const config = readStaffConfig(env);
  const portalConfig = readPortalConfig(env);
  const resources = portalConfig && readPortalResources(env);
  const portal = portalConfig && await PortalAuth.create(portalConfig);
  const auth = config && await StaffAuth.create(config.url, config.key, config.origin);
  const app = await NestFactory.create<NestExpressApplication>({
    module: ControlApiModule,
    controllers: auth ? [...staffControllers, ...(portal ? portalControllers : [])] : [],
    providers: [
      ...(auth ? [{ provide: StaffAuth, useValue: auth }] : []),
      ...(resources ? [{ provide: portalResourceConfig, useValue: resources }] : []),
      ...(portal ? [{ provide: PortalAuth, useValue: portal }] : []),
    ],
  }, { abortOnError: false, bodyParser: false });
  if (auth) {
    app.use(['/api/control/v1/staff', '/api/control/v1/businesses', '/api/control/v1/plans', '/api/control/v1/outlets',
      '/api/control/v1/tickets', '/api/control/v1/audit-events', '/api/control/v1/billing',
      ...(portal ? ['/api/control/v1/portal'] : [])], (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '') && req.headers.origin !== auth.origin) {
        res.statusCode = 403;
        res.end();
        return;
      }
      next();
    });
    app.useBodyParser('json', { limit: '8kb' });
    // Parse failures occur before controller filters and can contain credential fragments.
    app.use((err: Error & { status?: number }, _req: IncomingMessage,
      res: ServerResponse, next: (err: Error) => void) => {
      if (res.headersSent) return next(new Error('Invalid request body'));
      res.statusCode = err.status === 413 ? 413 : 400;
      res.end();
    });
  }
  app.setGlobalPrefix('api/control/v1');
  return { app, port };
}
