import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { displayJoinSchema, displayPublishSchema } from '@nventra/types';
import type { Server, Socket } from 'socket.io';
import {
  isPastMaxLifetime,
  sessionMaxSeconds,
  type SessionPayload,
} from '../auth/session';
import {
  effectivePermissions,
  permissionInclude,
} from '../auth/effective-permissions';
import { BranchAccessService } from '../common/services/branch-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { DisplayRegistry } from './display-registry';

interface SocketData {
  branchId?: string;
  userId?: string;
  permissions?: string[];
}

// Publishing to a customer display is part of taking an order at the till.
const DISPLAY_PUBLISH_PERMISSION = 'orders.create';

// One gateway, room-per-branch — KDS/table-status/order-tracking all join
// the branch room they care about and get pushed events by name
// ("kot.updated", "table.updated", "order.updated"). Kept as a single
// injectable service (not split per concern) until there's a real reason
// to scale gateways independently.
//
// CORS: explicit origin (same env var main.ts uses for the REST API), not
// `origin: true` — the WS handshake's initial polling request is a normal
// CORS-checked HTTP request, and `origin: true` + `credentials: true`
// together would reflect any calling origin while still allowing the
// session cookie through, which defeats the point of restricting origins at
// all on the REST side.
@Injectable()
@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:1995',
    credentials: true,
  },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  private readonly displays = new DisplayRegistry();

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
    private readonly config: ConfigService,
  ) {}

  // Every other realtime event (KOT contents, table/order status, customer
  // names) is scoped to whichever branch room a socket joins — before this
  // fix, `handleConnection` trusted the client-supplied `branchId` query
  // param outright with no session check at all, so any unauthenticated
  // client could pass `?branchId=<any-id>` and silently receive another
  // restaurant's live KDS/order/table stream. This now requires the same
  // httpOnly session cookie every REST call needs, and cross-checks the
  // requested branch against the authenticated user's own restaurant via
  // the same BranchAccessService REST controllers use — a socket that
  // fails either check is disconnected before joining any room.
  async handleConnection(client: Socket) {
    try {
      const token = this.extractSessionCookie(client);
      if (!token) throw new Error('No session cookie');

      const payload = this.jwt.verify<SessionPayload>(token);
      const now = Math.floor(Date.now() / 1000);
      if (isPastMaxLifetime(payload, now, sessionMaxSeconds(this.config)))
        throw new Error('Session expired');
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        include: permissionInclude,
      });
      if (!user || !user.isActive || (payload.tv ?? 0) !== user.tokenVersion)
        throw new Error('Session no longer valid');

      const branchId = client.handshake.query.branchId;
      if (typeof branchId !== 'string' || !branchId) {
        throw new Error('Missing branchId');
      }
      await this.branchAccess.assertAccess(user.restaurantId, branchId);
      // Remembered for the customer-display relay: its rooms are always built
      // from this verified branch, never from anything the client sends later.
      // Permissions are snapshotted for the display relay; revoking a
      // session bumps tokenVersion and disconnectUser() drops the socket.
      const data = client.data as SocketData;
      data.branchId = branchId;
      data.userId = user.id;
      data.permissions = effectivePermissions(user);

      await client.join(this.branchRoom(branchId));
      // Every socket also joins a room keyed to its own authenticated user
      // id, independent of which branch it's viewing — this is what lets
      // notifications.service.ts target a specific user (or a resolved set
      // of permission-holding users) without leaking to every other socket
      // sitting in the same branch room. `emitToBranch` stays intentionally
      // broad (table/KOT/order state genuinely is "everyone on this
      // branch"); a permission-gated notification (e.g. "kitchen only") is
      // NOT everyone-in-branch, so it must never go out via emitToBranch.
      await client.join(this.userRoom(user.id));
    } catch (err) {
      this.logger.warn(
        `Rejecting realtime connection: ${err instanceof Error ? err.message : String(err)}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client?: Pick<Socket, 'id'>) {
    // socket.io removes room membership automatically on disconnect; the
    // display codes this socket issued are freed here.
    if (client) this.displays.release(client.id);
  }

  emitToBranch(branchId: string, event: string, payload: unknown) {
    this.server.to(this.branchRoom(branchId)).emit(event, payload);
  }

  // Targets exactly the given users' sockets (wherever/whichever branch
  // they're currently viewing), regardless of branch-room membership. Used
  // by NotificationsService so a permission-gated or single-recipient
  // notification only reaches the staff it's actually meant for, not every
  // socket connected to that branch.
  emitToUsers(userIds: string[], event: string, payload: unknown) {
    if (userIds.length === 0) return;
    this.server.to(userIds.map((id) => this.userRoom(id))).emit(event, payload);
  }

  // Customer display pairing: a till (orders.create) issues a code by
  // publishing under it; the code stays with that user while any of their
  // sockets holds it (so a reconnecting till reclaims it); a display (any
  // device logged in to the same branch) may join only an issued code.
  @SubscribeMessage('display.join')
  async onDisplayJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ) {
    const parsed = displayJoinSchema.safeParse(body);
    const branchId = (client.data as SocketData | undefined)?.branchId;
    if (!parsed.success || !branchId) return { ok: false };
    if (!this.displays.allow(client.id, 'join')) return { ok: false };
    const room = this.displayRoom(branchId, parsed.data.code);
    if (!this.displays.isIssued(room)) return { ok: false };
    await client.join(room);
    return { ok: true };
  }

  @SubscribeMessage('display.publish')
  onDisplayPublish(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): { ok: boolean; error?: string } {
    const data = client.data as SocketData | undefined;
    if (!data?.permissions?.includes(DISPLAY_PUBLISH_PERMISSION))
      return { ok: false, error: 'forbidden' };
    const parsed = displayPublishSchema.safeParse(body);
    if (!parsed.success || !data.branchId || !data.userId) return { ok: false };
    if (!this.displays.allow(client.id, 'publish'))
      return { ok: false, error: 'rate-limited' };
    const room = this.displayRoom(data.branchId, parsed.data.code);
    if (this.displays.claim(room, client.id, data.userId) !== 'ok')
      return { ok: false, error: 'code-in-use' };
    this.server.to(room).emit('display.state', parsed.data.state);
    return { ok: true };
  }

  private displayRoom(branchId: string, code: string) {
    return `display:${branchId}:${code}`;
  }

  // "Log out of all devices": every socket a revoked user holds joined
  // their user room at connect time, so dropping that room drops them all.
  disconnectUser(userId: string) {
    this.server?.in(this.userRoom(userId)).disconnectSockets(true);
  }

  private branchRoom(branchId: string) {
    return `branch:${branchId}`;
  }

  private userRoom(userId: string) {
    return `user:${userId}`;
  }

  private extractSessionCookie(client: Socket): string | null {
    const raw = client.handshake.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      if (name === 'nventra_session') {
        return decodeURIComponent(part.slice(idx + 1).trim());
      }
    }
    return null;
  }
}
