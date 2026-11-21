import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Limited DB role that backups are restored as. Never a superuser. */
export const RESTORE_ROLE = 'nventra_restore';

/**
 * Deterministic password for the restore role, derived from the app's own
 * DB password so no extra secret has to be stored or configured. It
 * changes when the DB password rotates; managed database setup syncs the role.
 */
export function deriveRestorePassword(dbPassword: string): string {
  return createHmac('sha256', dbPassword)
    .update('nventra-restore-role-v1')
    .digest('hex');
}

/** PostgreSQL receives only a salted verifier, never a reusable plaintext secret. */
export function restorePasswordVerifier(password: string): string {
  // Derived passwords are ASCII hex, so SASLprep does not change their bytes.
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(client).digest('base64');
  const server = createHmac('sha256', salted)
    .update('Server Key')
    .digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}

/** DATABASE_RESTORE_URL if set, else the limited role on the same database. */
export function restoreConnectionUrl(): string | undefined {
  const explicit = process.env.DATABASE_RESTORE_URL;
  if (explicit) return explicit;
  try {
    const u = new URL(process.env.DATABASE_URL ?? '');
    const dbPassword = decodeURIComponent(u.password);
    if (!dbPassword) return undefined;
    u.username = RESTORE_ROLE;
    u.password = deriveRestorePassword(dbPassword);
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * Makes sure the restore role exists with only data privileges on the app
 * schema (DML + TRUNCATE on tables, USAGE/SELECT/UPDATE on sequences, no
 * CREATE, no pg_* server roles) for legacy or operator-managed deployments.
 * The stock database setup provisions the role before the backend starts.
 */
@Injectable()
export class RestoreRoleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RestoreRoleService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensure();
  }

  async ensure(): Promise<void> {
    // An operator-managed restore role is theirs to provision.
    if (
      process.env.NVENTRA_DATABASE_URL_FILE ||
      process.env.DATABASE_RESTORE_URL
    )
      return;
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ rolsuper: boolean }[]>(
        'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
      );
      if (!rows[0]?.rolsuper) {
        this.logger.log(
          'App DB role is not a superuser; set DATABASE_RESTORE_URL to a limited role to enable restores.',
        );
        return;
      }
      const dbPassword = decodeURIComponent(
        new URL(process.env.DATABASE_URL ?? '').password,
      );
      if (!dbPassword) return;
      const pw = restorePasswordVerifier(deriveRestorePassword(dbPassword)); // base64: safe literal
      const role = RESTORE_ROLE;
      const run = (q: string) => this.prisma.$executeRawUnsafe(q);
      await run(
        `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${pw}'; END IF; END $$`,
      );
      await run(
        `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${pw}'`,
      );
      await run(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await run(
        `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO ${role}`,
      );
      await run(
        `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
      );
      this.logger.log(
        `Restore role "${role}" is ready (data-only privileges).`,
      );
    } catch {
      this.logger.warn(
        'Could not prepare the restore role; check database role configuration.',
      );
    }
  }
}
