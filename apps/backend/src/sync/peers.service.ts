import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { SyncRegisterDto } from '@nventra/types';
import { PrismaService } from '../prisma/prisma.service';

export interface SyncPeerRecord {
  id: string;
  name: string;
  branchIds: string[];
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

/**
 * HQ's registry of branch installs (§4.1, G12, G13). A branch registers once
 * with the bootstrap SYNC_API_KEY and gets its own random key, stored here
 * only as a SHA-256 hash and revocable on its own. Every pull/push is then
 * authenticated by that key, and the device id used for routing and echo
 * filtering is the peer record's, never a value from the request.
 */
@Injectable()
export class SyncPeersService {
  constructor(private readonly prisma: PrismaService) {}

  async register(dto: SyncRegisterDto) {
    const existing = await this.prisma.syncPeer.findUnique({
      where: { id: dto.id },
    });
    if (existing?.revokedAt)
      throw new ConflictException(
        'This install was revoked at HQ. Ask HQ to remove the revocation, or sync from a new install.',
      );
    const branches = await this.prisma.branch.findMany({
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    let branchIds = [...new Set(dto.branchIds)];
    if (!branchIds.length) {
      if (branches.length !== 1)
        throw new BadRequestException(
          `Choose which branch this install runs: ${branches.map((b) => `${b.name} (${b.id})`).join(', ')}`,
        );
      branchIds = [branches[0].id];
    }
    const known = new Set(branches.map((b) => b.id));
    const unknown = branchIds.filter((b) => !known.has(b));
    if (unknown.length)
      throw new BadRequestException(`Unknown branch ${unknown.join(', ')}`);
    // One install per branch (§4.5): numbering and LWW rely on it.
    const taken = await this.prisma.syncPeer.findFirst({
      where: {
        id: { not: dto.id },
        revokedAt: null,
        branchIds: { hasSome: branchIds },
      },
    });
    if (taken)
      throw new ConflictException(
        `A branch you chose is already synced by "${taken.name}". Revoke that install at HQ (Settings > Sync) first.`,
      );
    const key = randomBytes(32).toString('hex');
    await this.prisma.syncPeer.upsert({
      where: { id: dto.id },
      create: { id: dto.id, name: dto.name, branchIds, keyHash: hash(key) },
      update: { name: dto.name, branchIds, keyHash: hash(key) },
    });
    return { id: dto.id, key, branchIds };
  }

  /** The active peer holding this key, or null. Constant-time compare. */
  async authenticate(id: string, key: string): Promise<SyncPeerRecord | null> {
    if (!id || !key) return null;
    const p = await this.prisma.syncPeer.findUnique({ where: { id } });
    if (!p || p.revokedAt) return null;
    const a = Buffer.from(hash(key), 'hex');
    const b = Buffer.from(p.keyHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    await this.prisma.syncPeer.update({
      where: { id },
      data: { lastSeenAt: new Date() },
    });
    return this.view(p);
  }

  async list(): Promise<SyncPeerRecord[]> {
    const rows = await this.prisma.syncPeer.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((p) => this.view(p));
  }

  async revoke(id: string): Promise<SyncPeerRecord> {
    const p = await this.prisma.syncPeer.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Sync install not found');
    const updated = await this.prisma.syncPeer.update({
      where: { id },
      data: { revokedAt: p.revokedAt ?? new Date() },
    });
    return this.view(updated);
  }

  private view(p: SyncPeerRecord & { keyHash?: string }): SyncPeerRecord {
    return {
      id: p.id,
      name: p.name,
      branchIds: p.branchIds,
      createdAt: p.createdAt,
      lastSeenAt: p.lastSeenAt,
      revokedAt: p.revokedAt,
    };
  }
}
