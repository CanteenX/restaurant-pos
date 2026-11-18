import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { preProcessFile } from 'typescript';

const CONTROL_OR_LICENSING_IMPORT =
  /(?:^|\/)(?:control(?:-api|-center)?|licen[cs](?:e|ing)|entitlement)(?:[./-]|$)/i;

describe('local POS checkout, settlement, refunds and closing', () => {
  it.each([
    'orders/orders.controller.ts',
    'orders/orders.module.ts',
    'orders/orders.service.ts',
    'accounting/accounting.controller.ts',
    'accounting/accounting.module.ts',
    'accounting/accounting.service.ts',
  ])('keeps %s independent of Control and licensing imports', (file) => {
    const source = readFileSync(join(__dirname, '..', file), 'utf8');
    const { importedFiles } = preProcessFile(source, true, true);
    const dependencies = importedFiles.map(({ fileName }) => fileName);

    expect(
      dependencies.filter((path) => CONTROL_OR_LICENSING_IMPORT.test(path)),
    ).toEqual([]);
  });

  it('keeps the retired entitlement policy out of the POS runtime source', () => {
    expect(
      existsSync(join(__dirname, '../licensing/operation-policy.ts')),
    ).toBe(false);
  });
});
