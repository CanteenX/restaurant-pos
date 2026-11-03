import { InventoryService } from './inventory.service';

const setup = () => {
  const prisma = {
    ingredient: {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findFirst: jest.fn(),
    },
    recipeIngredient: { count: jest.fn().mockResolvedValue(0) },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new InventoryService(
    prisma as never,
    {} as never,
    audit as never,
  );
  return { prisma, audit, svc };
};

describe('InventoryService ingredient audit trail', () => {
  it('records ingredient.created', async () => {
    const { prisma, audit, svc } = setup();
    prisma.ingredient.create.mockResolvedValue({
      id: 'i1',
      name: 'Flour',
      unit: 'kg',
    });
    await svc.createIngredient('b1', { name: 'Flour' } as never, 'u1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'ingredient.created',
        entity: 'Ingredient',
        entityId: 'i1',
      }),
    );
  });

  it('records ingredient.updated with changed fields', async () => {
    const { prisma, audit, svc } = setup();
    prisma.ingredient.findFirst.mockResolvedValue({
      id: 'i1',
      name: 'Flour',
      unit: 'kg',
    });
    prisma.ingredient.update.mockResolvedValue({
      id: 'i1',
      name: 'Rice',
      unit: 'kg',
    });
    await svc.updateIngredient('b1', 'i1', { name: 'Rice' }, 'u1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ingredient.updated',
        metadata: expect.objectContaining({
          changes: { name: { before: 'Flour', after: 'Rice' } },
        }),
      }),
    );
  });

  it('records ingredient.deleted only after delete succeeds', async () => {
    const { prisma, audit, svc } = setup();
    prisma.ingredient.findFirst.mockResolvedValue({ id: 'i1', name: 'Flour' });
    await svc.deleteIngredient('b1', 'i1', 'u1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ingredient.deleted', entityId: 'i1' }),
    );
  });

  it('does not audit a blocked delete', async () => {
    const { prisma, audit, svc } = setup();
    prisma.ingredient.findFirst.mockResolvedValue({ id: 'i1', name: 'Flour' });
    prisma.recipeIngredient.count.mockResolvedValue(2);
    await expect(svc.deleteIngredient('b1', 'i1', 'u1')).rejects.toThrow();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
