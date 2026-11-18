import type { IncomingMessage } from 'node:http';
import { BadRequestException, Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, UseFilters } from '@nestjs/common';
import type { z } from 'zod';
import { businessCreate, businessPatch, controlCursorPage, controlResourceId, outletCreate, outletPatch } from '@nventra/types';
import { StaffAuth } from '../staff/staff-auth.js';
import { sessionCookie, StaffExceptionFilter } from '../staff/staff.controller.js';
import { BusinessRegistry } from './registry.js';

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}

@Controller('businesses')
@UseFilters(StaffExceptionFilter)
export class BusinessController {
  private readonly registry: BusinessRegistry;
  constructor(@Inject(StaffAuth) auth: StaffAuth) { this.registry = new BusinessRegistry(auth.access); }

  @Get()
  list(@Req() req: IncomingMessage, @Query() query: unknown) {
    return this.registry.businesses(sessionCookie(req), input(controlCursorPage, query));
  }
  @Get(':businessId')
  detail(@Req() req: IncomingMessage, @Param('businessId') businessId: string) {
    return this.registry.business(sessionCookie(req), input(controlResourceId, businessId));
  }
  @Post()
  create(@Req() req: IncomingMessage, @Body() body: unknown) {
    return this.registry.createBusiness(sessionCookie(req), input(businessCreate, body));
  }
  @Patch(':businessId')
  update(@Req() req: IncomingMessage, @Param('businessId') id: string, @Body() body: unknown) {
    return this.registry.updateBusiness(sessionCookie(req), input(controlResourceId, id), input(businessPatch, body));
  }

  @Get(':businessId/outlets')
  outlets(@Req() req: IncomingMessage, @Param('businessId') businessId: string, @Query() query: unknown) {
    return this.registry.outlets(sessionCookie(req), input(controlResourceId, businessId), input(controlCursorPage, query));
  }
  @Get(':businessId/outlets/:id')
  outlet(@Req() req: IncomingMessage, @Param('businessId') businessId: string, @Param('id') id: string) {
    return this.registry.outlet(sessionCookie(req), input(controlResourceId, businessId), input(controlResourceId, id));
  }
  @Post(':businessId/outlets')
  createOutlet(@Req() req: IncomingMessage, @Param('businessId') businessId: string, @Body() body: unknown) {
    return this.registry.createOutlet(sessionCookie(req), input(controlResourceId, businessId), input(outletCreate, body));
  }
  @Patch(':businessId/outlets/:id')
  updateOutlet(@Req() req: IncomingMessage, @Param('businessId') businessId: string,
    @Param('id') id: string, @Body() body: unknown) {
    return this.registry.updateOutlet(sessionCookie(req), input(controlResourceId, businessId),
      input(controlResourceId, id), input(outletPatch, body));
  }
}
