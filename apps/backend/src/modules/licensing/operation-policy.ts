interface PosOperation {
  kind: 'read' | 'write';
  key: string;
}

const STARTER_WRITES = new Set([
  'order.create',
  'order.update',
  'payment.collect',
  'payment.refund',
  'receipt.issue',
  'receipt.reprint',
  'cash.close',
]);

// Operation metadata is defined by POS handlers. This policy only decides
// whether a paid entitlement is required; permission checks are separate.
export function requiresPaidLicence(operation: PosOperation): boolean {
  return operation.kind === 'write' && !STARTER_WRITES.has(operation.key);
}
