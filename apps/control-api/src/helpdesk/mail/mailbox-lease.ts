import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../../node_modules/.prisma/control-client/index.js';

const address = z.string().max(254).pipe(z.email());
const uint32 = z.number().int().min(0).max(0xffff_ffff);
const epoch = z.string().regex(/^[1-9][0-9]{0,9}$/).refine((v) => Number(v) <= 0xffff_ffff);
const advanceSchema = z.strictObject({ status: z.enum(['resync','batch']), uidValidity: epoch, throughUid: uint32 });
export type MailboxAdvance = z.infer<typeof advanceSchema>;
export type MailboxLease = { mailbox: string; token: string; uidValidity?: string; afterUid: number };
type Position = { uid_validity: bigint | null; through_uid: bigint };

export async function acquireMailbox(db: PrismaClient, mailbox: string): Promise<MailboxLease | null> {
  if (!address.safeParse(mailbox).success || mailbox !== mailbox.toLowerCase()) throw new Error('Invalid mailbox');
  const token = randomUUID();
  const [row] = await db.$queryRaw<Position[]>`INSERT INTO control.mailbox_cursor AS c (mailbox, lease_token, lease_until)
    VALUES (${mailbox}, ${token}::uuid, clock_timestamp() + interval '45 seconds')
    ON CONFLICT (mailbox) DO UPDATE SET lease_token = excluded.lease_token, lease_until = clock_timestamp() + interval '45 seconds'
    WHERE c.lease_until IS NULL OR c.lease_until <= clock_timestamp() RETURNING uid_validity, through_uid`;
  return row ? { mailbox, token, uidValidity: row.uid_validity?.toString(), afterUid: Number(row.through_uid) } : null;
}

export async function releaseMailbox(db: PrismaClient, lease: MailboxLease) {
  await db.$executeRaw`UPDATE control.mailbox_cursor SET lease_token = NULL, lease_until = NULL
    WHERE mailbox = ${lease.mailbox} AND lease_token = ${lease.token}::uuid`;
}

/** Call after the bounded network poll finishes. The callback performs database work only. */
export async function commitMailbox<T>(db: PrismaClient, claim: MailboxLease, position: MailboxAdvance,
  write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const lease = { ...claim };
  const validated = advanceSchema.safeParse(position);
  if (!validated.success) throw new Error('Invalid mailbox advance');
  const advance = validated.data;
  return db.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Position[]>`SELECT uid_validity, through_uid FROM control.mailbox_cursor
      WHERE mailbox = ${lease.mailbox} AND lease_token = ${lease.token}::uuid AND lease_until > clock_timestamp() FOR UPDATE`;
    if (!row || row.uid_validity?.toString() !== lease.uidValidity || Number(row.through_uid) !== lease.afterUid) {
      throw new Error('Mailbox lease expired or changed');
    }
    const valid = advance.status === 'resync'
      ? lease.uidValidity !== undefined && advance.uidValidity !== lease.uidValidity && advance.throughUid === 0
      : (!lease.uidValidity || advance.uidValidity === lease.uidValidity) &&
        advance.throughUid >= lease.afterUid && advance.throughUid <= lease.afterUid + 8;
    if (!valid) throw new Error('Invalid mailbox advance');
    const result = await write(tx);
    const changed = await tx.$executeRaw`UPDATE control.mailbox_cursor SET uid_validity = ${BigInt(advance.uidValidity)},
      through_uid = ${BigInt(advance.throughUid)}, lease_token = NULL, lease_until = NULL
      WHERE mailbox = ${lease.mailbox} AND lease_token = ${lease.token}::uuid AND lease_until > clock_timestamp()`;
    if (!changed) throw new Error('Mailbox lease expired or changed');
    return result;
  });
}
