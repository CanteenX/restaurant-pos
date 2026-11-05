import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  syncConnectionSchema,
  syncPullQuerySchema,
  syncPushSchema,
  syncRegisterSchema,
  syncSettingsSchema,
} from '@nventra/types';
import type { ZodType } from 'zod';
import { Auth } from '../common/decorators/auth.decorator';
import { SyncPeersService } from './peers.service';
import {
  AllowBootstrapKey,
  SyncKeyGuard,
  SyncPeerGuard,
} from './sync-key.guard';
import type { PeerRequest } from './sync-key.guard';
import { SyncChange, SyncService } from './sync.service';

/** Shared Zod schema at the boundary, with its own message on failure. */
function parse<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new BadRequestException(
      r.error.issues[0]?.message ?? 'Invalid input',
    );
  return r.data;
}

function peerOf(req: PeerRequest) {
  if (!req.syncPeer) throw new UnauthorizedException();
  return req.syncPeer;
}

/**
 * Called by other installs, machine-authenticated (no user session): the
 * bootstrap key registers an install, its own key then syncs it.
 */
@ApiTags('sync')
@Controller('v1/sync-peer')
export class SyncPeerController {
  constructor(
    private readonly sync: SyncService,
    private readonly peers: SyncPeersService,
  ) {}

  @Get('ping')
  @UseGuards(SyncPeerGuard)
  @AllowBootstrapKey()
  async ping() {
    return {
      ok: true,
      role: 'server',
      schema: await this.sync.schemaVersion(),
      // Clients refuse to sync while their clock is off from this one.
      now: Date.now(),
    };
  }

  @Post('register')
  @HttpCode(200)
  @UseGuards(SyncKeyGuard)
  register(@Body() body: unknown) {
    return this.peers.register(parse(syncRegisterSchema, body));
  }

  @Get('pull')
  @UseGuards(SyncPeerGuard)
  pull(@Query() query: unknown, @Req() req: PeerRequest) {
    const q = parse(syncPullQuerySchema, query);
    return this.sync.pull(BigInt(q.since), peerOf(req));
  }

  @Post('push')
  @HttpCode(200)
  @UseGuards(SyncPeerGuard)
  push(@Body() body: unknown, @Req() req: PeerRequest) {
    const b = parse(syncPushSchema, body);
    // Each change is checked on its own (assertWellFormed in apply).
    return this.sync.push(peerOf(req), b.changes as unknown as SyncChange[]);
  }
}

/** Used by the settings page on this install. */
@ApiTags('sync')
@Controller('v1/sync')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly peers: SyncPeersService,
  ) {}

  @Auth('settings.manage')
  @Get('status')
  status() {
    return this.sync.publicStatus();
  }

  @Auth('settings.manage')
  @Post('test')
  async test(@Body() body: unknown) {
    const b = parse(syncConnectionSchema, body);
    try {
      return await this.sync.testConnection(b.serverUrl, b.apiKey);
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Connection failed',
      );
    }
  }

  @Auth('settings.manage')
  @Put('settings')
  async enable(@Body() body: unknown) {
    const b = parse(syncSettingsSchema, body);
    try {
      await this.sync.enable(b.serverUrl, b.apiKey, b.mode, b.branchIds);
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Sync failed',
      );
    }
    return this.sync.publicStatus();
  }

  @Auth('settings.manage')
  @Post('run')
  async run() {
    try {
      const r = await this.sync.runOnce();
      return { ...r, ...(await this.sync.publicStatus()) };
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Sync failed',
      );
    }
  }

  /** Re-try every change kept in sync_rejected (apply is LWW, so safe). */
  @Auth('settings.manage')
  @Post('rejected/retry')
  async retryRejected() {
    try {
      const r = await this.sync.retryAllRejected();
      return { ...r, ...(await this.sync.publicStatus()) };
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Sync failed',
      );
    }
  }

  @Auth('settings.manage')
  @Post('disable')
  async disable() {
    await this.sync.disable();
    return this.sync.publicStatus();
  }

  /** HQ: branch installs registered here. */
  @Auth('settings.manage')
  @Get('peers')
  listPeers() {
    return this.peers.list();
  }

  /** HQ: cut one branch install off without rotating anyone else's key. */
  @Auth('settings.manage')
  @Post('peers/:id/revoke')
  revokePeer(@Param('id') id: string) {
    return this.peers.revoke(id);
  }

  /** HQ: settled branch orders whose lines, total and payments disagree. */
  @Auth('settings.manage')
  @Get('flags')
  flags() {
    return this.sync.orderFlags();
  }
}
