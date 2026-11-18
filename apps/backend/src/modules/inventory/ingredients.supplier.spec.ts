import { BadRequestException } from '@nestjs/common';
import { InventoryService } from './inventory.service';

// preferredSupplierId must point at a supplier of the SAME branch: a foreign
// or unknown id is a 400, never a silent cross-tenant link or an FK 500.
const setup = () => {
  const prisma = {
    ingredient: {
      create: jest.fn().mockResolvedValue({ id: 'i1', name: 'Rice' }),
      update: jest.fn().mockResolvedValue({ id: 'i1', name: 'Rice' }),
      findFirst: jest.fn().mockResolvedValue({ id: 'i1', name: 'Rice' }),
    },
    supplier: { findFirst: jest.fn() },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new InventoryService(
    prisma as never,
    {} as never,
    audit as never,
  );
  return { prisma, svc };
};

describe('InventoryService preferred supplier validation', () => {
  it('rejects a supplier from another branch on create', async () => {
    const { prisma, svc } = setup();
    prisma.supplier.findFirst.mockResolvedValue(null);
    await expect(
      svc.createIngredient('b1', {
        name: 'Rice',
        preferredSupplierId: 'foreign',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.supplier.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign', branchId: 'b1' },
      select: { id: true },
    });
    expect(prisma.ingredient.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown supplier on update', async () => {
    const { prisma, svc } = setup();
    prisma.supplier.findFirst.mockResolvedValue(null);
    await expect(
      svc.updateIngredient('b1', 'i1', { preferredSupplierId: 'nope' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.ingredient.update).not.toHaveBeenCalled();
  });

  it('accepts a supplier of the same branch', async () => {
    const { prisma, svc } = setup();
    prisma.supplier.findFirst.mockResolvedValue({ id: 's1' });
    await svc.createIngredient('b1', {
      name: 'Rice',
      preferredSupplierId: 's1',
    } as never);
    expect(prisma.ingredient.create).toHaveBeenCalled();
  });

  it('skips the lookup when no supplier or a clear (null) is sent', async () => {
    const { prisma, svc } = setup();
    await svc.createIngredient('b1', { name: 'Rice' } as never);
    await svc.updateIngredient('b1', 'i1', { preferredSupplierId: null });
    expect(prisma.supplier.findFirst).not.toHaveBeenCalled();
    expect(prisma.ingredient.update).toHaveBeenCalled();
  });
});
