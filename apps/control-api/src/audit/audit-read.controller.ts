import type { IncomingMessage } from 'node:http';
import { BadRequestException, Controller, Get, Inject, Query, Req, UseFilters } from '@nestjs/common';
import { z } from 'zod';
import { StaffAuth } from '../staff/staff-auth.js';
import { sessionCookie, StaffExceptionFilter } from '../staff/staff.controller.js';

const page = z.strictObject({
  limit: z.string().regex(/^(?:[1-9][0-9]?|100)$/).default('20').transform(Number),
  cursor: z.string().regex(/^[1-9][0-9]{0,18}$/).transform(BigInt).pipe(z.bigint().max(9223372036854775807n)).optional(),
});
const fields = {
  sequence: true, occurredAtMs: true, actorType: true, actorId: true, businessId: true, action: true,
  subjectType: true, subjectId: true, requestId: true, outcome: true, changedFields: true,
} as const;

@Controller('audit-events')
@UseFilters(StaffExceptionFilter)
export class AuditReadController {
  constructor(@Inject(StaffAuth) private readonly auth: StaffAuth) {}

  @Get()
  list(@Req() request: IncomingMessage, @Query() query: unknown) {
    return this.auth.access.withPermission(sessionCookie(request), 'cc.audit.read', async tx => {
      const parsed = page.safeParse(query);
      if (!parsed.success) throw new BadRequestException();
      const { limit, cursor } = parsed.data;
      const rows = await tx.auditEvent.findMany({ select: fields, where: { sequence: { lt: cursor } },
        orderBy: { sequence: 'desc' }, take: limit + 1 });
      const items = rows.slice(0, limit).map(row => ({
        ...row, sequence: row.sequence.toString(), occurredAtMs: row.occurredAtMs.toString(),
      }));
      return { items, nextCursor: rows.length > limit ? items[items.length - 1].sequence : null };
    });
  }
}
