import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import type { ControlPermissionKey } from '@nventra/types';

/** Access class of one HTTP route. Staff routes name the single permission they enforce. */
export type RouteAccess = ControlPermissionKey | 'public' | 'staff-session' | 'portal-session';

export interface MatrixContext {
  readonly business: string; readonly outlet: string; readonly invoice: string; readonly ticket: string;
  readonly staff: string; readonly account: string;
}
export interface MatrixRequest { readonly path: string; readonly body?: unknown; readonly headers?: Record<string, string> }
export interface RouteDeclaration { readonly access: RouteAccess; readonly send?: (c: MatrixContext) => MatrixRequest }

type Controller = abstract new (...args: never[]) => object;

/** Reads the real Nest route metadata, so a new handler cannot exist without appearing here. */
export function listControllerRoutes(controllers: readonly Controller[]): string[] {
  const routes: string[] = [];
  for (const controller of controllers) {
    const prefix = String(Reflect.getMetadata('path', controller) ?? '/');
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler: unknown = (controller.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata('method', handler) as number | undefined;
      if (method === undefined) continue;
      const path = String(Reflect.getMetadata('path', handler) ?? '/');
      routes.push(RequestMethod[method] + ' /' + [prefix, path].join('/').split('/').filter(Boolean).join('/'));
    }
  }
  return routes.sort();
}

const uuid = '00000000-0000-4000-8000-0000000000ff';
const page = '?limit=1';
const cp = (access: ControlPermissionKey, send: RouteDeclaration['send']): RouteDeclaration => ({ access, send });
const dates = { planCode: 'standard', planVersion: 1, startsAt: '2030-01-01T00:00:00.000Z', endsAt: '2031-01-01T00:00:00.000Z' };

/**
 * Declared permission of every route. The inventory test fails for any controller route missing here
 * and for any entry here that no controller serves; the HTTP matrix proves the declaration is enforced.
 */
export const ROUTE_ACCESS: Readonly<Record<string, RouteDeclaration>> = Object.freeze({
  'POST /staff/session/challenge': { access: 'public' },
  'POST /staff/enrollment': { access: 'public' },
  'POST /staff/session/verify': { access: 'public' },
  'GET /staff/session': { access: 'staff-session' },
  'POST /staff/session/logout': { access: 'staff-session' },
  'GET /staff/users': cp('cc.staff.read', () => ({ path: 'staff/users' + page })),
  'PATCH /staff/users/:id/grants': cp('cc.staff.manage', (c) => ({ path: 'staff/users/' + c.staff + '/grants', body: { grants: [] } })),
  'POST /staff/users/:id/reset-factor': cp('cc.staff.manage', (c) => ({ path: 'staff/users/' + c.staff + '/reset-factor', body: {} })),
  'POST /staff/users/:id/revoke-sessions': cp('cc.staff.manage', (c) => ({ path: 'staff/users/' + c.staff + '/revoke-sessions', body: {} })),

  'GET /businesses': cp('cc.business.read', () => ({ path: 'businesses' + page })),
  'GET /businesses/:businessId': cp('cc.business.read', (c) => ({ path: 'businesses/' + c.business })),
  'POST /businesses': cp('cc.business.manage', () => ({ path: 'businesses', body: { legalName: 'Matrix Ltd', displayName: 'Matrix' } })),
  'PATCH /businesses/:businessId': cp('cc.business.manage', (c) => ({ path: 'businesses/' + c.business, body: { displayName: 'Renamed' } })),
  'GET /businesses/:businessId/outlets': cp('cc.business.read', (c) => ({ path: 'businesses/' + c.business + '/outlets' + page })),
  'GET /businesses/:businessId/outlets/:id': cp('cc.business.read', (c) => ({ path: 'businesses/' + c.business + '/outlets/' + c.outlet })),
  'POST /businesses/:businessId/outlets': cp('cc.business.manage', (c) => ({ path: 'businesses/' + c.business + '/outlets',
    body: { displayName: 'Matrix outlet', timeZone: 'Asia/Kolkata' } })),
  'PATCH /businesses/:businessId/outlets/:id': cp('cc.business.manage', (c) => ({ path: 'businesses/' + c.business + '/outlets/' + c.outlet,
    body: { displayName: 'Renamed outlet' } })),

  'GET /plans': cp('cc.plan.read', () => ({ path: 'plans' })),
  'GET /plans/renewals': cp('cc.plan.read', () => ({ path: 'plans/renewals' + page })),
  'GET /outlets/:id/service-plans': cp('cc.plan.read', (c) => ({ path: 'outlets/' + c.outlet + '/service-plans' + page })),
  'POST /outlets/:id/service-plans/:operation': cp('cc.plan.manage', (c) => ({ path: 'outlets/' + c.outlet + '/service-plans/assign',
    body: { requestKey: uuid, ...dates } })),

  'GET /tickets': cp('cc.ticket.read', () => ({ path: 'tickets' + page })),
  'GET /tickets/eligible-owners': cp('cc.ticket.manage', () => ({ path: 'tickets/eligible-owners' + page })),
  'GET /tickets/:id': cp('cc.ticket.read', (c) => ({ path: 'tickets/' + c.ticket + page })),
  'PATCH /tickets/:id': cp('cc.ticket.manage', (c) => ({ path: 'tickets/' + c.ticket, body: { priority: 'high' } })),
  'POST /tickets/:id/messages': cp('cc.ticket.reply', (c) => ({ path: 'tickets/' + c.ticket + '/messages', body: { requestKey: uuid, text: 'Hello' } })),
  'POST /tickets/:id/notes': cp('cc.ticket.manage', (c) => ({ path: 'tickets/' + c.ticket + '/notes', body: { requestKey: uuid, text: 'Note' } })),
  'POST /tickets/:id/portal-replies': cp('cc.ticket.reply', (c) => ({ path: 'tickets/' + c.ticket + '/portal-replies',
    body: { requestKey: uuid, text: 'Hello' } })),

  'GET /audit-events': cp('cc.audit.read', () => ({ path: 'audit-events' + page })),

  'GET /businesses/:id/invoices': cp('cc.billing.read', (c) => ({ path: 'businesses/' + c.business + '/invoices' + page })),
  'POST /businesses/:id/invoices': cp('cc.billing.manage', (c) => ({ path: 'businesses/' + c.business + '/invoices',
    body: { requestKey: uuid, reference: 'INV-1', amountPaise: 100, description: 'Plan', dueOn: '2030-01-01' } })),
  'GET /businesses/:id/invoices/:invoiceId/payments': cp('cc.billing.read', (c) =>
    ({ path: 'businesses/' + c.business + '/invoices/' + c.invoice + '/payments' + page })),
  'POST /businesses/:id/invoices/:invoiceId/payments': cp('cc.billing.manage', (c) =>
    ({ path: 'businesses/' + c.business + '/invoices/' + c.invoice + '/payments',
      body: { requestKey: uuid, reference: 'PAY-1', amountPaise: 100, method: 'upi' } })),
  'GET /billing/overdue': cp('cc.billing.read', () => ({ path: 'billing/overdue' + page })),

  'GET /businesses/:id/hosted-access': cp('cc.hosted.read', (c) => ({ path: 'businesses/' + c.business + '/hosted-access' })),
  'PATCH /businesses/:id/hosted-access': cp('cc.hosted.manage', (c) => ({ path: 'businesses/' + c.business + '/hosted-access',
    headers: { 'if-match': '"0"' }, body: { status: 'suspended', reason: 'matrix', requestKey: uuid } })),

  'GET /businesses/:id/portal-accounts': cp('cc.portal.read', (c) => ({ path: 'businesses/' + c.business + '/portal-accounts' + page })),
  'POST /businesses/:id/portal-accounts': cp('cc.portal.manage', (c) => ({ path: 'businesses/' + c.business + '/portal-accounts',
    body: { email: 'matrix-portal@example.test' } })),
  'POST /businesses/:id/portal-accounts/:accountId/reissue': cp('cc.portal.manage', (c) =>
    ({ path: 'businesses/' + c.business + '/portal-accounts/' + c.account + '/reissue', body: {} })),
  'POST /businesses/:id/portal-accounts/:accountId/revoke': cp('cc.portal.manage', (c) =>
    ({ path: 'businesses/' + c.business + '/portal-accounts/' + c.account + '/revoke', body: {} })),

  'POST /portal/activate': { access: 'public' },
  'POST /portal/session': { access: 'public' },
  'GET /portal/session': { access: 'portal-session' },
  'POST /portal/logout': { access: 'portal-session' },
  'GET /portal/summary': { access: 'portal-session' },
  'GET /portal/invoices': { access: 'portal-session' },
  'GET /portal/invoices/:id/payments': { access: 'portal-session' },
  'GET /portal/outlets': { access: 'portal-session' },
  'GET /portal/downloads': { access: 'portal-session' },
  'GET /portal/downloads/:id': { access: 'portal-session' },
  'GET /portal/tickets': { access: 'portal-session' },
  'GET /portal/tickets/:id': { access: 'portal-session' },
  'POST /portal/tickets': { access: 'portal-session' },
});
