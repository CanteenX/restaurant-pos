// Container start step (see apps/backend/Dockerfile CMD), before
// `prisma migrate deploy`: moves a pre-rename install's Postgres role and
// database to nventra / nventra_pos. No-op on current installs. Also:
//   pnpm --filter ./apps/backend db:upgrade-identity     (local dev)
import { Logger } from '@nestjs/common';
import { prismaConnector, upgradeDbIdentity } from './db-identity-upgrade';

const log = new Logger('DbIdentityUpgrade');

const MESSAGES = {
  skipped: 'DATABASE_URL is not the stock nventra identity; nothing to do',
  current: 'database identity is current',
  upgraded:
    'renamed Postgres role nodedr -> nventra and database nodedr_restaurant -> nventra_pos',
  unavailable:
    'could not log in as nventra or nodedr; leaving it to prisma migrate deploy',
} as const;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    log.warn('DATABASE_URL is not set; skipping');
    return;
  }
  const result = await upgradeDbIdentity({
    url,
    connectAs: prismaConnector(url),
  });
  log.log(MESSAGES[result]);
}

main().catch((e: unknown) => {
  log.error(
    `database identity upgrade failed: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
});
