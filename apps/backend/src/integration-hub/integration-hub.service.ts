import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { IntegrationConnection, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getProvider, listProviders } from './providers/registry';
import type { IntegrationProvider, TestResult } from './providers/provider';
import { IntegrationOutboxService } from './outbox/integration-outbox.service';
import { decryptSecret, encryptSecret } from './secret-box';

export interface ConnectInput {
  externalAccountId?: string;
  /** Only the fields being set or changed; omitted secrets keep their stored value. */
  credentials: Record<string, string>;
  /** Platform outlet id -> our branch id. Replaces the stored map when given. */
  outlets?: Record<string, string>;
  /** Our menu item id -> the platform's item id. Replaces the stored map when given. */
  itemMap?: Record<string, string>;
}

type StoredConfig = {
  credentialKeys?: string[];
  outlets?: Record<string, string>;
  itemMap?: Record<string, string>;
} | null;

const ctxKey = (restaurantId: string, provider: string) =>
  `${restaurantId}:${provider}`;

@Injectable()
export class IntegrationHubService {
  private readonly logger = new Logger(IntegrationHubService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: IntegrationOutboxService,
  ) {}

  private provider(key: string): IntegrationProvider {
    const p = getProvider(key);
    if (!p) throw new NotFoundException('Unknown integration');
    return p;
  }

  /** What the API may show: never the credentials, only which fields are set. */
  private view(
    c: IntegrationConnection | null,
    outbox: { pending: number; dead: number } = { pending: 0, dead: 0 },
  ) {
    if (!c) return null;
    const cfg = c.config as StoredConfig;
    const keys = cfg?.credentialKeys;
    return {
      outlets: cfg?.outlets ?? {},
      outbox,
      id: c.id,
      enabled: c.enabled,
      status: c.status,
      externalAccountId: c.externalAccountId,
      credentialsSet: Object.fromEntries((keys ?? []).map((k) => [k, true])),
      lastSyncAt: c.lastSyncAt,
      lastSuccessAt: c.lastSuccessAt,
      lastError: c.lastError,
      updatedAt: c.updatedAt,
    };
  }

  async list(restaurantId: string) {
    const rows = await this.prisma.integrationConnection.findMany({
      where: { restaurantId },
    });
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    const counts = await this.outbox.counts(rows.map((r) => r.id));
    return listProviders().map((p) => ({
      key: p.key,
      name: p.name,
      category: p.category,
      description: p.description,
      capabilities: p.capabilities,
      accountIdLabel: p.accountIdLabel ?? null,
      webhookPath: p.capabilities.webhooks
        ? `/api/v1/integration-hub/webhook/${restaurantId}/${p.key}`
        : null,
      requirements: p.requirements ?? null,
      credentialFields: p.credentialFields,
      connection: this.view(
        byProvider.get(p.key) ?? null,
        counts.get(byProvider.get(p.key)?.id ?? ''),
      ),
    }));
  }

  private async log(
    connectionId: string,
    level: 'INFO' | 'WARN' | 'ERROR',
    event: string,
    message: string,
  ) {
    await this.prisma.integrationLog.create({
      data: { connectionId, level, event, message: message.slice(0, 500) },
    });
  }

  private async require(restaurantId: string, providerKey: string) {
    this.provider(providerKey);
    const c = await this.prisma.integrationConnection.findUnique({
      where: { restaurantId_provider: { restaurantId, provider: providerKey } },
    });
    if (!c) throw new NotFoundException('This integration is not set up yet');
    return c;
  }

  async connect(
    restaurantId: string,
    userId: string,
    providerKey: string,
    input: ConnectInput,
  ) {
    const provider = this.provider(providerKey);
    const known = new Set(provider.credentialFields.map((f) => f.key));
    for (const k of Object.keys(input.credentials)) {
      if (!known.has(k)) {
        throw new BadRequestException(`Unknown credential field "${k}"`);
      }
    }
    const existing = await this.prisma.integrationConnection.findUnique({
      where: { restaurantId_provider: { restaurantId, provider: providerKey } },
    });

    // Merge onto what is stored so changing one field never forces re-typing the rest.
    let merged: Record<string, string> = {};
    if (existing?.credentialsEnc) {
      try {
        merged = JSON.parse(
          decryptSecret(
            existing.credentialsEnc,
            ctxKey(restaurantId, providerKey),
          ),
        ) as Record<string, string>;
      } catch {
        merged = {}; // unreadable (key changed): the caller must re-enter everything
      }
    }
    for (const [k, v] of Object.entries(input.credentials)) {
      if (v.trim() === '') delete merged[k];
      else merged[k] = v.trim();
    }
    if (merged.webhookSecret && merged.webhookSecret.length < 16) {
      throw new BadRequestException(
        'The webhook signing secret must be at least 16 characters',
      );
    }
    const missing = provider.credentialFields
      .filter((f) => f.required && !merged[f.key])
      .map((f) => f.label);
    if (missing.length) {
      throw new BadRequestException(`Enter: ${missing.join(', ')}`);
    }
    const accountId =
      input.externalAccountId?.trim() || existing?.externalAccountId || null;
    const outlets =
      input.outlets !== undefined
        ? await this.checkOutlets(restaurantId, input.outlets)
        : ((existing?.config as StoredConfig)?.outlets ?? undefined);
    const itemMap =
      input.itemMap !== undefined
        ? await this.checkItemMap(restaurantId, input.itemMap)
        : ((existing?.config as StoredConfig)?.itemMap ?? undefined);
    if (provider.accountIdLabel && !provider.accountIdOptional && !accountId) {
      throw new BadRequestException(`Enter the ${provider.accountIdLabel}`);
    }

    const data = {
      externalAccountId: accountId,
      credentialsEnc: encryptSecret(
        JSON.stringify(merged),
        ctxKey(restaurantId, providerKey),
      ),
      config: {
        credentialKeys: Object.keys(merged),
        ...(outlets ? { outlets } : {}),
        ...(itemMap ? { itemMap } : {}),
      } as Prisma.InputJsonValue,
      // Saving keys is not the same as a working connection: only a test
      // that the adapter itself observed succeeding can set CONNECTED.
      status:
        existing?.enabled === false
          ? ('DISABLED' as const)
          : ('PENDING_CONFIGURATION' as const),
      lastError: null,
    };
    const row = existing
      ? await this.prisma.integrationConnection.update({
          where: { id: existing.id },
          data,
        })
      : await this.prisma.integrationConnection.create({
          data: {
            ...data,
            restaurantId,
            provider: providerKey,
            createdById: userId,
          },
        });
    await this.log(row.id, 'INFO', 'credentials_saved', 'Credentials saved');
    return this.view(row);
  }

  /** Every mapped branch must belong to this restaurant. */
  private async checkOutlets(
    restaurantId: string,
    outlets: Record<string, string>,
  ) {
    const ids = [...new Set(Object.values(outlets))];
    const own = await this.prisma.branch.count({
      where: { restaurantId, id: { in: ids } },
    });
    if (own !== ids.length) {
      throw new BadRequestException(
        'An outlet is mapped to a branch that is not part of this restaurant',
      );
    }
    return outlets;
  }

  /** Every mapped dish must belong to one of this restaurant's branches. */
  private async checkItemMap(
    restaurantId: string,
    itemMap: Record<string, string>,
  ) {
    const ids = Object.keys(itemMap);
    const own = await this.prisma.menuItem.count({
      where: { id: { in: ids }, branch: { restaurantId } },
    });
    if (own !== ids.length) {
      throw new BadRequestException(
        'An item is mapped that is not part of this restaurant',
      );
    }
    const ext = Object.values(itemMap);
    if (new Set(ext).size !== ext.length) {
      throw new BadRequestException(
        'Two dishes are mapped to the same platform item id',
      );
    }
    return itemMap;
  }

  /** Publishes one branch's menu to the platform now (queued, retried). */
  async syncMenu(restaurantId: string, providerKey: string, branchId: string) {
    const c = await this.require(restaurantId, providerKey);
    const provider = this.provider(providerKey);
    if (!provider.capabilities.menuSync) {
      throw new BadRequestException('This integration cannot publish a menu');
    }
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, restaurantId },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Unknown branch');
    const queued = await this.prisma.$transaction((tx) =>
      this.outbox.enqueueMenuPush(tx, branch.id),
    );
    await this.log(c.id, 'INFO', 'menu_sync', 'Menu publish queued');
    return { queued };
  }

  /** Re-queues the platform calls that gave up, e.g. after fixing the API key. */
  async retryFailed(restaurantId: string, providerKey: string) {
    const c = await this.require(restaurantId, providerKey);
    const res = await this.outbox.retryDead(c.id);
    await this.log(
      c.id,
      'INFO',
      'outbox_retry',
      `Retrying ${res.requeued} failed platform update(s)`,
    );
    return res;
  }

  async setEnabled(
    restaurantId: string,
    providerKey: string,
    enabled: boolean,
  ) {
    const c = await this.require(restaurantId, providerKey);
    const row = await this.prisma.integrationConnection.update({
      where: { id: c.id },
      data: {
        enabled,
        // Re-enabling does not assume the old connection still works.
        status: enabled ? 'PENDING_CONFIGURATION' : 'DISABLED',
      },
    });
    await this.log(
      c.id,
      'INFO',
      enabled ? 'enabled' : 'disabled',
      enabled ? 'Enabled - run a connection test' : 'Disabled',
    );
    return this.view(row);
  }

  async test(restaurantId: string, providerKey: string) {
    const provider = this.provider(providerKey);
    const c = await this.require(restaurantId, providerKey);
    if (!c.enabled) {
      throw new BadRequestException(
        'Enable this integration before testing it',
      );
    }
    let credentials: Record<string, string>;
    try {
      credentials = JSON.parse(
        decryptSecret(
          c.credentialsEnc ?? '',
          ctxKey(restaurantId, providerKey),
        ),
      ) as Record<string, string>;
    } catch {
      const msg =
        'The saved credentials can no longer be read (the server key changed). Enter them again.';
      await this.prisma.integrationConnection.update({
        where: { id: c.id },
        data: {
          status: 'AUTH_EXPIRED',
          lastError: msg,
          lastSyncAt: new Date(),
        },
      });
      await this.log(c.id, 'ERROR', 'test', msg);
      throw new BadRequestException(msg);
    }

    let result: TestResult;
    try {
      result = await provider.testConnection({
        restaurantId,
        externalAccountId: c.externalAccountId,
        credentials,
      });
    } catch (e) {
      this.logger.warn(`${providerKey} test threw: ${(e as Error).message}`);
      result = {
        ok: false,
        status: 'SYNC_ERROR' as const,
        message: 'The connection test failed unexpectedly.',
      };
    }
    const now = new Date();
    const row = await this.prisma.integrationConnection.update({
      where: { id: c.id },
      data: {
        status: result.status,
        lastSyncAt: now,
        ...(result.ok
          ? { lastSuccessAt: now, lastError: null }
          : { lastError: result.message }),
      },
    });
    await this.log(c.id, result.ok ? 'INFO' : 'WARN', 'test', result.message);
    return {
      ok: result.ok,
      message: result.message,
      connection: this.view(row),
    };
  }

  /** Removes the connection and, with it, the stored credentials and its log. */
  async disconnect(restaurantId: string, providerKey: string) {
    const c = await this.require(restaurantId, providerKey);
    await this.prisma.integrationConnection.delete({ where: { id: c.id } });
    return { ok: true };
  }

  async logs(restaurantId: string, providerKey: string) {
    const c = await this.require(restaurantId, providerKey);
    return this.prisma.integrationLog.findMany({
      where: { connectionId: c.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        level: true,
        event: true,
        message: true,
        createdAt: true,
      },
    });
  }
}
