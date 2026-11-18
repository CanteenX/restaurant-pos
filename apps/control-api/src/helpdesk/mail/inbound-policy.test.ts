import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkInboundMailBudget,
  classifyInboundMail,
  INBOUND_MAIL_BUDGETS,
  type InboundMailEnvelope,
} from './inbound-policy.ts';

const ordinary = {
  wireBytes: 500,
  decodedTextBytes: 130,
  mimeParts: 4,
  mimeDepth: 2,
  processingMs: 30,
  attachmentCount: 0,
};

const budgets = {
  wireBytes: 2_097_152,
  decodedTextBytes: 65_536,
  mimeParts: 32,
  mimeDepth: 8,
  processingMs: 2_000,
};

void test('keeps all incremental limits explicit and inclusive', () => {
  assert.deepEqual(INBOUND_MAIL_BUDGETS, budgets);
  assert.equal(Object.isFrozen(INBOUND_MAIL_BUDGETS), true);

  const measurements = Object.keys(budgets) as (keyof typeof budgets)[];
  for (const measurement of measurements) {
    const limit = budgets[measurement];
    assert.equal(checkInboundMailBudget(measurement, 0), null);
    assert.equal(checkInboundMailBudget(measurement, limit), null);
    const rejection = { disposition: 'quarantine', reason: 'budget-exceeded', measurement };
    assert.deepEqual(checkInboundMailBudget(measurement, limit + 1), rejection);
    assert.deepEqual(
      classifyInboundMail({}, { ...ordinary, [measurement]: limit + 1 }),
      rejection,
    );
  }
  assert.deepEqual(classifyInboundMail({}, { ...budgets, attachmentCount: 0 }), {
    disposition: 'accept', reason: 'accepted', omittedAttachments: 0,
  });
});

void test('quarantines invalid counters without throwing or silently treating them as zero', () => {
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const wireRejection = {
      disposition: 'quarantine', reason: 'invalid-measurement', measurement: 'wireBytes',
    };
    assert.deepEqual(checkInboundMailBudget('wireBytes', value), wireRejection);
    assert.deepEqual(classifyInboundMail({}, { ...ordinary, wireBytes: value }), wireRejection);
    assert.deepEqual(classifyInboundMail({}, { ...ordinary, attachmentCount: value }), {
      disposition: 'quarantine', reason: 'invalid-measurement', measurement: 'attachmentCount',
    });
  }
  assert.deepEqual(classifyInboundMail({}, { ...ordinary, attachmentCount: 5 }), {
    disposition: 'quarantine', reason: 'invalid-measurement', measurement: 'attachmentCount',
  });
});

void test('returns stable skip reasons for provider spam, reports, auto replies, lists and self-mail', () => {
  const cases = [
    [{ providerSpam: true }, 'provider-spam'],
    [{ deliveryReport: true }, 'delivery-report'],
    [{ autoSubmitted: true }, 'auto-submitted'],
    [{ mailingList: true }, 'mailing-list'],
    [{ knownSelfMail: true }, 'self-mail'],
  ] as const satisfies ReadonlyArray<readonly [InboundMailEnvelope, string]>;

  for (const [envelope, reason] of cases) {
    assert.deepEqual(classifyInboundMail(envelope, ordinary), { disposition: 'skip', reason });
  }
});

void test('gives malformed or oversized mail priority and orders competing skip reasons', () => {
  const allSignals = {
    providerSpam: true,
    knownSelfMail: true,
    deliveryReport: true,
    autoSubmitted: true,
    mailingList: true,
  };
  assert.deepEqual(classifyInboundMail(allSignals, { ...ordinary, mimeParts: 33 }), {
    disposition: 'quarantine', reason: 'budget-exceeded', measurement: 'mimeParts',
  });
  assert.deepEqual(classifyInboundMail(allSignals, ordinary), {
    disposition: 'skip', reason: 'provider-spam',
  });
  assert.deepEqual(classifyInboundMail({ ...allSignals, providerSpam: false }, ordinary), {
    disposition: 'skip', reason: 'self-mail',
  });
});

void test('ignores raw mail headers and returns attachment omission counts only', () => {
  const extraHeaders = {
    providerSpam: false,
    headers: {
      'authentication-results': 'example.test; dmarc=pass',
      'auto-submitted': 'auto-replied',
      'x-spam-flag': 'YES',
    },
    urls: ['https://example.invalid/attachment'],
  };
  assert.deepEqual(classifyInboundMail(extraHeaders, ordinary), {
    disposition: 'accept', reason: 'accepted', omittedAttachments: 0,
  });
  assert.deepEqual(classifyInboundMail(extraHeaders, { ...ordinary, attachmentCount: 4 }), {
    disposition: 'accept', reason: 'attachments-omitted', omittedAttachments: 4,
  });
});

for (const measurement of ['wireBytes', 'mimeParts', 'mimeDepth'] as const) {
  void test(`requires positive ${measurement} for a completed parse`, () => {
    assert.equal(checkInboundMailBudget(measurement, 0), null);
    assert.deepEqual(classifyInboundMail({}, { ...ordinary, [measurement]: 0 }), {
      disposition: 'quarantine', reason: 'invalid-measurement', measurement,
    });
  });
}

void test('requires a counted MIME part at every measured depth', () => {
  assert.deepEqual(classifyInboundMail({}, { ...ordinary, mimeParts: 2, mimeDepth: 3 }), {
    disposition: 'quarantine', reason: 'invalid-measurement', measurement: 'mimeDepth',
  });
});

void test('accepts a minimal MIME message with no decoded text', () => {
  const minimal = {
    wireBytes: 1,
    decodedTextBytes: 0,
    mimeParts: 1,
    mimeDepth: 1,
    processingMs: 0,
  };
  assert.deepEqual(classifyInboundMail({}, { ...minimal, attachmentCount: 0 }), {
    disposition: 'accept', reason: 'accepted', omittedAttachments: 0,
  });
  assert.deepEqual(classifyInboundMail({}, { ...minimal, attachmentCount: 1 }), {
    disposition: 'accept', reason: 'attachments-omitted', omittedAttachments: 1,
  });
});
