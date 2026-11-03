import { Injectable } from '@nestjs/common';
import {
  TALLY_LEDGER_DEFAULTS,
  tallyMappingSchema,
  type TallyLedgerKey,
  type TallyMappingDto,
} from '@nventra/types';
import { PrismaService } from '../../prisma/prisma.service';

// Stored in IntegrationConnection.config under a private provider key, so no
// migration is needed (the integration hub lists only registered providers).
const PROVIDER = 'tally-mapping';

export function resolveMapping(
  stored: unknown,
): Record<TallyLedgerKey, string> {
  const parsed = tallyMappingSchema.safeParse(stored ?? {});
  return { ...TALLY_LEDGER_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
}

@Injectable()
export class TallyMappingService {
  constructor(private readonly prisma: PrismaService) {}

  async get(restaurantId: string) {
    const row = await this.prisma.integrationConnection.findUnique({
      where: { restaurantId_provider: { restaurantId, provider: PROVIDER } },
    });
    return resolveMapping(row?.config);
  }

  async save(restaurantId: string, dto: TallyMappingDto) {
    const merged = resolveMapping({
      ...(await this.get(restaurantId)),
      ...dto,
    });
    await this.prisma.integrationConnection.upsert({
      where: { restaurantId_provider: { restaurantId, provider: PROVIDER } },
      create: { restaurantId, provider: PROVIDER, config: merged },
      update: { config: merged },
    });
    return merged;
  }
}
