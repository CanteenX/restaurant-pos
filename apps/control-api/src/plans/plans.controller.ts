import type { IncomingMessage } from 'node:http';
import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, UseFilters } from '@nestjs/common';
import { z } from 'zod';
import { controlCursorPage, controlEmptyBody, controlResourceId, servicePlanDates, servicePlanKey, servicePlanOperation, servicePlanPage } from '@nventra/types';
import { StaffAuth } from '../staff/staff-auth.js';
import { sessionCookie, StaffExceptionFilter } from '../staff/staff.controller.js';
import { ServicePlans } from './plans.js';

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}

const renewalPage = controlCursorPage.extend({
  cursor: z.string().max(65).transform((value) => value.split('|'))
    .pipe(z.tuple([z.iso.datetime({ precision: 3 }), controlResourceId])).optional(),
});

@Controller()
@UseFilters(StaffExceptionFilter)
export class PlansController {
  private readonly plans: ServicePlans;
  constructor(@Inject(StaffAuth) auth: StaffAuth) { this.plans = new ServicePlans(auth.access); }

  @Get('plans')
  list(@Req() req: IncomingMessage, @Query() query: unknown) {
    input(controlEmptyBody, query);
    return this.plans.catalog(sessionCookie(req));
  }

  @Get('plans/renewals')
  renewals(@Req() req: IncomingMessage, @Query() query: unknown) {
    return this.plans.renewals(sessionCookie(req), input(renewalPage, query));
  }

  @Get('outlets/:id/service-plans')
  history(@Req() req: IncomingMessage, @Param('id') id: string, @Query() page: unknown) {
    return this.plans.history(sessionCookie(req), input(controlResourceId, id), input(servicePlanPage, page));
  }

  @Post('outlets/:id/service-plans/:operation')
  change(@Req() req: IncomingMessage, @Param('id') id: string, @Param('operation') operation: string, @Body() body: unknown) {
    const parsed = input(servicePlanOperation, operation);
    return this.plans.change(sessionCookie(req), input(controlResourceId, id), parsed === 'cancel'
      ? { operation: parsed, ...input(servicePlanKey, body) }
      : { operation: parsed, ...input(servicePlanDates, body) });
  }
}
