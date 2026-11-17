// Owner password recovery, run on the server (docs/SUPPORT-RUNBOOK.md, section 4):
//   docker compose exec backend node dist/src/system/reset-owner-password.cli.js --email owner@example.com
//   pnpm --filter ./apps/backend run reset-owner-password -- --email owner@example.com   (from source)
// Generates a new password, prints it once, and signs the owner out everywhere.
import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  generatePassword,
  parseResetArgs,
  resetOwnerPassword,
} from './reset-owner-password';

const log = new Logger('ResetOwnerPassword');

async function main() {
  const args = parseResetArgs(process.argv.slice(2));
  const newPassword = generatePassword();
  const prisma = new PrismaClient();
  try {
    const result = await resetOwnerPassword(prisma, { ...args, newPassword });
    // The one place the new password appears: this operator's terminal.
    process.stdout.write(
      [
        `Password reset for ${args.email} (restaurant ${result.restaurantId}).`,
        `New password: ${newPassword}`,
        'Give it to the owner over a private channel. Every old session was signed out.',
        ...(result.isActive
          ? []
          : [
              'Warning: this account is disabled; another owner must re-enable it.',
            ]),
        '',
      ].join('\n'),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  log.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
