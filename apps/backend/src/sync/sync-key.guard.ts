import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { SyncPeerRecord, SyncPeersService } from './peers.service';
import { SyncService } from './sync.service';

/** Request of an authenticated branch install (see SyncPeerGuard). */
export type PeerRequest = Request & { syncPeer?: SyncPeerRecord };

const sameKey = (given: string, want: string | null) => {
  if (!given || !want) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The bootstrap SYNC_API_KEY (`x-sync-key`), constant-time compare. Only
 * registration uses it; a registered install syncs with its own key.
 */
@Injectable()
export class SyncKeyGuard implements CanActivate {
  constructor(private readonly sync: SyncService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<Request>();
    const s = await this.sync.state();
    if (
      s.role !== 'server' ||
      !sameKey(String(req.headers['x-sync-key'] ?? ''), s.apiKey)
    )
      throw new UnauthorizedException();
    return true;
  }
}

const ALLOW_BOOTSTRAP = 'sync:allowBootstrap';
/** Also accept the bootstrap key on this route (connection test). */
export const AllowBootstrapKey = () => SetMetadata(ALLOW_BOOTSTRAP, true);

/**
 * A registered branch install: `x-sync-peer` (its device id) and its own
 * `x-sync-key`, checked against the hash in sync_peers (G12, G13). The peer
 * record goes on the request; nothing else identifies the caller.
 */
@Injectable()
export class SyncPeerGuard implements CanActivate {
  constructor(
    private readonly sync: SyncService,
    private readonly peers: SyncPeersService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<PeerRequest>();
    const s = await this.sync.state();
    if (s.role !== 'server') throw new UnauthorizedException();
    const key = String(req.headers['x-sync-key'] ?? '');
    const id = String(req.headers['x-sync-peer'] ?? '');
    if (id) {
      const peer = await this.peers.authenticate(id, key);
      if (!peer) throw new UnauthorizedException();
      req.syncPeer = peer;
      return true;
    }
    if (
      this.reflector.get<boolean>(ALLOW_BOOTSTRAP, ctx.getHandler()) &&
      sameKey(key, s.apiKey)
    )
      return true;
    throw new UnauthorizedException();
  }
}
