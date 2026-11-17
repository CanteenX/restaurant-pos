import { createHmac } from 'node:crypto';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Limited DB role that backups are restored as. Never a superuser. */
export const RESTORE_ROLE = 'nventra_restore';

/**
 * Deterministic password for the restore role, derived from the app's own
 * DB password so no extra secret has to be stored or configured. It
 * changes when the DB password rotates; the role is re-synced at startup.
 */
export function deriveRestorePassword(dbPassword: string): string {
  return createHmac('sha256', dbPassword)
    .update('nventra-restore-role-v1')
    .digest('hex');
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
 * CREATE, no pg_* server roles). Runs at startup when the app is connected
 * as a superuser (the shipped docker-compose default); idempotent.
 */
@Injectable()
export class RestoreRoleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RestoreRoleService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensure();
  }

  async ensure(): Promise<void> {
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
      const pw = deriveRestorePassword(dbPassword); // hex: safe in a literal
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
    } catch (err) {
      this.logger.warn(
        `Could not prepare the restore role: ${(err as Error).message}`,
      );
    }
  }
}
