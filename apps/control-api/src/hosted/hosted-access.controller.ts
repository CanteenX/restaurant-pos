import type { IncomingMessage, ServerResponse } from 'node:http';
import { BadRequestException, Body, Controller, Get, Headers, HttpException, Inject,
  Param, Patch, Req, Res, UseFilters } from '@nestjs/common';
import { controlResourceId } from '@nventra/types';
import type { z } from 'zod';
import { StaffAuth } from '../staff/staff-auth.js';
import { sessionCookie, StaffExceptionFilter } from '../staff/staff.controller.js';
import { hostedAccessPatch, hostedAccessTag } from './hosted-access-policy.js';
import { HostedAccessService } from './hosted-access.service.js';

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}

@Controller('businesses/:id/hosted-access')
@UseFilters(StaffExceptionFilter)
export class HostedAccessController {
  private readonly hosted: HostedAccessService;
  constructor(@Inject(StaffAuth) auth: StaffAuth) { this.hosted = new HostedAccessService(auth.access); }

  @Get()
  async read(@Req() req: IncomingMessage, @Res({ passthrough: true }) res: ServerResponse, @Param('id') id: string) {
    const value = await this.hosted.read(sessionCookie(req), input(controlResourceId, id));
    res.setHeader('ETag', '"' + value.version + '"');
    return value;
  }

  @Patch()
  async change(@Req() req: IncomingMessage, @Res({ passthrough: true }) res: ServerResponse,
    @Param('id') id: string, @Headers('if-match') tag: unknown, @Body() body: unknown) {
    const cookie = sessionCookie(req);
    if (tag === undefined) throw new HttpException('Hosted access revision required', 428);
    const value = await this.hosted.write(cookie, input(controlResourceId, id), input(hostedAccessTag, tag), input(hostedAccessPatch, body));
    res.setHeader('ETag', '"' + value.version + '"');
    return value;
  }
}
