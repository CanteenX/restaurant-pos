import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { AuditEvent, Prisma } from '../../node_modules/.prisma/control-client/index.js';

const code = z.string().regex(/^[A-Za-z][A-Za-z0-9._]{0,63}$/);
const eventSchema = z.strictObject({
  actorType: z.enum(['staff', 'service', 'system']),
  actorId: z.uuid(),
  businessId: z.uuid().nullish(),
  action: code,
  subjectType: code,
  subjectId: z.uuid().nullish(),
  requestId: z.uuid(),
  outcome: z.enum(['succeeded', 'denied', 'failed']),
  changedFields: z.array(code).max(24).default([]),
});

const genesisHash = '0'.repeat(64);
const checkpointSchema = z.strictObject({
  sequence: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
type AuditReader = Pick<Prisma.TransactionClient, 'auditEvent'>;
type AuditCheckpoint = z.infer<typeof checkpointSchema>;

export async function appendAuditEvent(tx: Prisma.TransactionClient, input: unknown): Promise<bigint> {
  const event = eventSchema.parse(input);
  const [{ sequence }] = await tx.$queryRaw<{ sequence: bigint }[]>`
    SELECT control.append_audit_event(
      ${event.actorType}, ${event.actorId}::uuid, ${event.businessId ?? null}::uuid,
      ${event.action}, ${event.subjectType}, ${event.subjectId ?? null}::uuid,
      ${event.requestId}::uuid, ${event.outcome}, ${event.changedFields}::text[]
    ) AS sequence
  `;
  return sequence;
}

export async function captureAuditCheckpoint(db: AuditReader): Promise<AuditCheckpoint> {
  const tip = await db.auditEvent.findFirst({ orderBy: { sequence: 'desc' } });
  return { sequence: tip?.sequence.toString() ?? '0', hash: tip?.eventHash ?? genesisHash };
}

function hashEvent(event: AuditEvent): string {
  const fields = [
    event.sequence, event.occurredAtMs, event.actorType, event.actorId, event.businessId ?? '',
    event.action, event.subjectType, event.subjectId ?? '', event.requestId, event.outcome,
    event.changedFields.join(','), event.previousHash,
  ];
  return createHash('sha256').update(fields.join('|'), 'utf8').digest('hex');
}

export async function verifyAuditCheckpoint(db: AuditReader, input: unknown): Promise<boolean> {
  const checkpoint = checkpointSchema.safeParse(input);
  if (!checkpoint.success) return false;

  const target = BigInt(checkpoint.data.sequence);
  if (target > 9_223_372_036_854_775_807n) return false;

  let sequence = 0n;
  let previousHash = genesisHash;
  while (sequence < target) {
    const events = await db.auditEvent.findMany({
      where: { sequence: { gt: sequence, lte: target } },
      orderBy: { sequence: 'asc' },
      take: 128,
    });
    if (events.length === 0) return false;

    for (const event of events) {
      if (event.sequence !== sequence + 1n || event.previousHash !== previousHash ||
        event.eventHash !== hashEvent(event)) return false;
      sequence = event.sequence;
      previousHash = event.eventHash;
    }
  }
  return previousHash === checkpoint.data.hash;
}
