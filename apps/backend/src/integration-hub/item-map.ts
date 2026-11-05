// Merge-safe edits to a channel's item map (#60). The settings page sends only
// what changed; this applies it onto the stored map so a stale browser tab or
// a second editor never wipes mappings it did not touch.
import { BadRequestException } from '@nestjs/common';
import type { IntegrationItemMapPatchDto } from '@nventra/types';
import type { ItemMap } from './aggregator-menu';

export function mergeItemMap(
  stored: ItemMap | undefined,
  patch: IntegrationItemMapPatchDto,
): ItemMap {
  const next: ItemMap = { ...(stored ?? {}) };
  for (const id of patch.remove) delete next[id];
  Object.assign(next, patch.set);
  const ext = Object.values(next);
  if (new Set(ext).size !== ext.length) {
    throw new BadRequestException(
      'Two dishes are mapped to the same platform item id',
    );
  }
  return next;
}
