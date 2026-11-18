import { requiresPaidLicence } from './operation-policy';

describe('requiresPaidLicence', () => {
  it.each([
    'order.create',
    'order.update',
    'payment.collect',
    'payment.refund',
    'receipt.issue',
    'receipt.reprint',
    'cash.close',
  ])('keeps %s available in Starter', (key) => {
    expect(requiresPaidLicence({ kind: 'write', key })).toBe(false);
  });

  it.each(['order.history', 'report.export', 'future.read'])(
    'keeps read access for %s available in Starter',
    (key) => {
      expect(requiresPaidLicence({ kind: 'read', key })).toBe(false);
    },
  );

  it.each(['future.paidMutation', 'constructor', '__proto__'])(
    'requires an entitlement for the unclassified write %s',
    (key) => {
      expect(requiresPaidLicence({ kind: 'write', key })).toBe(true);
    },
  );
});
