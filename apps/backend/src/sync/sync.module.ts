import { Module } from '@nestjs/common';
import { SyncPeersService } from './peers.service';
import { SyncKeyGuard, SyncPeerGuard } from './sync-key.guard';
import { SyncController, SyncPeerController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  controllers: [SyncPeerController, SyncController],
  providers: [SyncService, SyncPeersService, SyncKeyGuard, SyncPeerGuard],
})
export class SyncModule {}
