/**
 * Apply wire and decoded UTF-8 byte limits while reading and decoding. Count
 * MIME parts as they are reached, with root depth 1. Use an abortable deadline
 * and round elapsed milliseconds up when checking the processing budget.
 */
export const INBOUND_MAIL_BUDGETS = Object.freeze({
  wireBytes: 2 * 1024 * 1024,
  decodedTextBytes: 64 * 1024,
  mimeParts: 32,
  mimeDepth: 8,
  processingMs: 2_000,
});

export type InboundMailMeasurement = keyof typeof INBOUND_MAIL_BUDGETS;

export type InboundMailMeasurements = Readonly<Record<InboundMailMeasurement, number>> & {
  readonly attachmentCount: number;
};

/** The adapter constructs these flags from provider and parsed envelope metadata. */
export type InboundMailEnvelope = Readonly<{
  /** Provider spam folder or label. */
  providerSpam?: boolean;
  /** An owned mailbox identity verified by the adapter or an outbound message match. */
  knownSelfMail?: boolean;
  /** A parsed delivery-status or disposition-notification report. */
  deliveryReport?: boolean;
  /** A parsed automated-submission signal. */
  autoSubmitted?: boolean;
  /** A parsed mailing-list identifier. */
  mailingList?: boolean;
}>;

const suppressions = [
  ['providerSpam', 'provider-spam'],
  ['knownSelfMail', 'self-mail'],
  ['deliveryReport', 'delivery-report'],
  ['autoSubmitted', 'auto-submitted'],
  ['mailingList', 'mailing-list'],
] as const;

type BudgetRejection = {
  disposition: 'quarantine';
  reason: 'invalid-measurement' | 'budget-exceeded';
  measurement: InboundMailMeasurement | 'attachmentCount';
};

export type InboundMailDisposition =
  | BudgetRejection
  | { disposition: 'skip'; reason: (typeof suppressions)[number][1] }
  | {
      disposition: 'accept';
      reason: 'accepted' | 'attachments-omitted';
      omittedAttachments: number;
    };

export function suppressedInboundMail(envelope: InboundMailEnvelope): Extract<InboundMailDisposition, { disposition: 'skip' }> | null {
  for (const [flag, reason] of suppressions) {
    if (envelope[flag] === true) return { disposition: 'skip', reason };
  }
  return null;
}

function isCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Check the running value before continuing to fetch or parse. */
export function checkInboundMailBudget(
  measurement: InboundMailMeasurement,
  value: number,
): BudgetRejection | null {
  if (!isCounter(value)) {
    return { disposition: 'quarantine', reason: 'invalid-measurement', measurement };
  }
  if (value > INBOUND_MAIL_BUDGETS[measurement]) {
    return { disposition: 'quarantine', reason: 'budget-exceeded', measurement };
  }
  return null;
}

const measurements = Object.keys(INBOUND_MAIL_BUDGETS) as InboundMailMeasurement[];
const requiredMeasurements = ['wireBytes', 'mimeParts', 'mimeDepth'] as const;

/**
 * Apply the completed parse policy before passing plain text to ticket intake.
 * Sender authorization and tenant assignment are separate intake decisions.
 */
export function classifyInboundMail(
  envelope: InboundMailEnvelope,
  measured: InboundMailMeasurements,
): InboundMailDisposition {
  for (const measurement of measurements) {
    const rejection = checkInboundMailBudget(measurement, measured[measurement]);
    if (rejection) return rejection;
  }


  const missingMeasurement = requiredMeasurements.find((measurement) => measured[measurement] === 0);
  const invalidStructure = missingMeasurement ??
    (measured.mimeDepth > measured.mimeParts ? 'mimeDepth' : undefined);
  if (invalidStructure) {
    return {
      disposition: 'quarantine',
      reason: 'invalid-measurement',
      measurement: invalidStructure,
    };
  }

  const { attachmentCount, mimeParts } = measured;
  if (!isCounter(attachmentCount) || attachmentCount > mimeParts) {
    return {
      disposition: 'quarantine',
      reason: 'invalid-measurement',
      measurement: 'attachmentCount',
    };
  }

  const skipped = suppressedInboundMail(envelope);
  if (skipped) return skipped;

  return {
    disposition: 'accept',
    reason: attachmentCount === 0 ? 'accepted' : 'attachments-omitted',
    omittedAttachments: attachmentCount,
  };
}
