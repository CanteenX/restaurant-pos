import { PrismaService } from '../prisma/prisma.service';
import { ApplyResult, SyncApplier } from './apply';
import { SyncChange } from './outbox';

/** Rejections a later cycle may get past: the parent row arrives afterwards. */
const PARKED = /violates foreign key|23503|waiting for parent row/;
const RETRY_PAGE = 200;

interface BranchSide {
  branches: string[];
  localPeer: string;
}

/**
 * Branch-side handling of rejected changes: putting back HQ-owned rows HQ
 * refused to take, and re-trying kept rejections (sync_rejected).
 */
export class RejectedReplay {
  constructor(
    private readonly prisma: PrismaService,
    private readonly applier: SyncApplier,
  ) {}

  /**
   * HQ answered a rejected change to one of its rows with its own copy
   * (Conflict.restore): put the row back here, so the branch shows what HQ
   * has. The rejected change itself stays in sync_rejected for review (#83).
   */
  async applyRestores(conflicts: ApplyResult['conflicts'], side: BranchSide) {
    const restores = conflicts.flatMap((c) => (c.restore ? [c.restore] : []));
    if (!restores.length) return;
    await this.applier.apply(restores, {
      origin: '__skip',
      tieWins: true,
      receiver: 'branch',
      branches: side.branches,
      localPeer: side.localPeer,
    });
  }

  /**
   * Re-tries rejections kept before this cycle: the parked ones (a parent
   * row that had not arrived yet, e.g. a child pulled a page before its
   * parent's newest entry), or all of them when asked. Replay is safe
   * because apply is last-writer-wins: a change superseded meanwhile is
   * skipped. Resolved rows are removed; the rest keep their latest error.
   */
  async retry(
    o: BranchSide & {
      all: boolean;
      keptBefore: bigint;
      push: (changes: SyncChange[]) => Promise<ApplyResult>;
    },
  ) {
    const rows = await this.prisma.$queryRawUnsafe<
      { id: bigint; side: string; change: SyncChange; error: string }[]
    >(
      `SELECT id, side, change, error FROM sync_rejected
        WHERE change IS NOT NULL AND id <= $1 ORDER BY id LIMIT ${RETRY_PAGE}`,
      o.keptBefore,
    );
    const out = { pulled: 0, pushed: 0 };
    for (const side of ['pull', 'push'] as const) {
      const batch = rows.filter(
        (r) => r.side === side && (o.all || PARKED.test(r.error)),
      );
      if (!batch.length) continue;
      const changes = batch.map((r) => r.change);
      const res =
        side === 'pull'
          ? await this.applier.apply(changes, {
              origin: '__skip',
              tieWins: true,
              receiver: 'branch',
              branches: o.branches,
              localPeer: o.localPeer,
            })
          : await o.push(changes);
      if (side === 'pull') out.pulled += res.applied;
      else {
        out.pushed += res.applied;
        await this.applyRestores(res.conflicts, o);
      }
      await this.settle(batch, res);
    }
    return out;
  }

  private async settle(
    batch: { id: bigint; change: SyncChange }[],
    res: ApplyResult,
  ) {
    const failed = new Map(
      res.conflicts.map((c) => [`${c.tbl}\u0000${c.pk}`, c.error]),
    );
    for (const r of batch) {
      const err = failed.get(`${r.change.tbl}\u0000${r.change.pkKey}`);
      if (err === undefined)
        await this.prisma.$executeRawUnsafe(
          `DELETE FROM sync_rejected WHERE id = $1`,
          r.id,
        );
      else
        await this.prisma.$executeRawUnsafe(
          `UPDATE sync_rejected SET error = $2 WHERE id = $1`,
          r.id,
          err,
        );
    }
  }
}
