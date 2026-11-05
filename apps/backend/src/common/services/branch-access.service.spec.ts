import { ForbiddenException } from '@nestjs/common';
import { BranchAccessService } from './branch-access.service';
import type { PrismaService } from '../../prisma/prisma.service';

describe('BranchAccessService.assertAccess', () => {
  const findFirst = jest.fn();
  const svc = new BranchAccessService({
    branch: { findFirst },
  } as unknown as PrismaService);

  beforeEach(() => findFirst.mockReset());

  // Prisma drops `undefined` filters, so a missing branchId would match any
  // branch of the caller's restaurant and let later branch-scoped lookups
  // (`where: { id, branchId: undefined }`) reach other tenants' rows.
  it.each([undefined, null, '', '   '])(
    'rejects a missing branchId (%p) without querying',
    async (branchId) => {
      findFirst.mockResolvedValue({ id: 'any' });
      await expect(
        svc.assertAccess('r1', branchId as unknown as string),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(findFirst).not.toHaveBeenCalled();
    },
  );

  it('rejects a branch of another restaurant', async () => {
    findFirst.mockResolvedValue(null);
    await expect(svc.assertAccess('r1', 'b2')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'b2', restaurantId: 'r1' },
      select: { id: true },
    });
  });

  it('allows a branch of the caller restaurant', async () => {
    findFirst.mockResolvedValue({ id: 'b1' });
    await expect(svc.assertAccess('r1', 'b1')).resolves.toBeUndefined();
  });
});
