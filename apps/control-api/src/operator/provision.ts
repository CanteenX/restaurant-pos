import { createHash } from 'node:crypto';
import { controlChallengeSchema, CONTROL_ROLE_PRESETS } from '@nventra/types';
import { hash } from 'bcrypt';
import { z } from 'zod';

const { email, enrollmentProof, password } = controlChallengeSchema.shape;
const proof = enrollmentProof.unwrap();
const request = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('create'), email, password: password.refine((s) => s.length >= 12),
    preset: z.enum(['OWNER', 'MANAGER', 'SUPPORT', 'MARKETING']), proof }),
  z.strictObject({ operation: z.literal('rotate'), email, proof }),
]);

async function readRequest() {
  if (process.stdin.isTTY || process.argv.length !== 2) throw new Error();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      if (bytes > 4096) throw new Error();
      chunks.push(buffer);
    }
    const input = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return request.parse(JSON.parse(input));
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

async function main() {
  if (process.env.DEBUG || process.env.RUST_LOG || process.env.NODE_DEBUG) throw new Error();
  const data = await readRequest();
  const url = process.env.CONTROL_OPERATOR_DATABASE_URL;
  if (!url || !['postgresql:', 'postgres:'].includes(new URL(url).protocol)) throw new Error();
  const { PrismaClient } = await import('../../node_modules/.prisma/control-client/index.js');
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    let verifier: string | null = null, grants: readonly string[] | null = null;
    if (data.operation === 'create') {
      if (data.password === data.proof) throw new Error();
      verifier = await hash(data.password, 12);
      grants = CONTROL_ROLE_PRESETS[data.preset];
    }
    const digest = createHash('sha256').update(Buffer.from(data.proof, 'base64url')).digest();
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL search_path = pg_catalog, pg_temp`;
      const [login] = await tx.$queryRaw<{ dedicated: boolean }[]>`
        SELECT current_user = session_user AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb
          AND NOT r.rolreplication AND NOT r.rolbypassrls AND r.rolcanlogin
          AND pg_has_role(r.oid, 'control_staff_operator', 'MEMBER')
          AND NOT pg_has_role(r.oid, 'control_runtime', 'MEMBER')
          AND NOT pg_has_role(r.oid, d.datdba, 'MEMBER') AS dedicated
        FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname = current_database()
        WHERE r.rolname = session_user`;
      if (!login.dedicated) throw new Error();
      await tx.$executeRaw`SET LOCAL ROLE control_staff_operator`;
      await tx.$executeRaw`SELECT control.provision_staff(${data.operation}, ${data.email}, ${verifier}::text,
        ${grants}::text[], ${digest}::bytea)`;
    });
  } finally { await db.$disconnect(); }
}

void main().catch(() => { process.stderr.write('Staff provisioning failed.\n'); process.exitCode = 1; });
