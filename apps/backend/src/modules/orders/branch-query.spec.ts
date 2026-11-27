import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RequiredBranchIdPipe } from '../../common/pipes/required-branch-id.pipe';
import { OrdersController } from './orders.controller';
import { MenuController } from '../menu/menu.controller';

function branchPipes(controller: object, method: string): unknown[] {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) as
    Record<string, { data?: string; pipes: unknown[] }> | undefined;
  const branch = Object.values(args ?? {}).find(
    (arg) => arg.data === 'branchId',
  );
  if (!branch) throw new Error(`branchId query missing for ${method}`);
  return branch.pipes;
}

describe('branch query validation placement', () => {
  it.each(['printDiagnostics', 'printTest', 'printLabels', 'openDrawer'])(
    'keeps branchId optional for %s',
    (method) => {
      expect(branchPipes(OrdersController, method)).not.toContain(
        RequiredBranchIdPipe,
      );
    },
  );
  it.each([
    [OrdersController, 'listOpen'],
    [OrdersController, 'createOrder'],
    [MenuController, 'listCategories'],
    [MenuController, 'listItems'],
  ])('requires branchId for %p %s', (controller, method) => {
    expect(branchPipes(controller, method)).toContain(RequiredBranchIdPipe);
  });
});
