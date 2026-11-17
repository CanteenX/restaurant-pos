/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method -- jest mocks */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EMAIL_TEMPLATE_DEFAULTS } from '../email/templates/defaults';
import { renderEmail } from '../email/templates/renderer';
import { ReceiptEmailService } from './receipt-email.service';

const orderRow = {
  id: 'o1',
  orderNumber: '1042',
  type: 'DINE_IN',
  status: 'PAID',
  branchId: 'b1',
  createdAt: new Date('2026-11-15T15:12:00Z'),
  table: null,
  customer: { name: 'Asha', phone: null },
  subtotal: 1100,
  discountAmount: 110,
  taxAmount: 47.14,
  tipAmount: 0,
  loyaltyPointsRedeemed: 0,
  loyaltyDiscountAmount: 0,
  totalAmount: 990,
  items: [
    {
      nameSnapshot: 'Paneer Tikka',
      quantity: 2,
      unitPriceSnapshot: 300,
      lineTotal: 600,
      taxRateSnapshot: 5,
      modifiers: [],
    },
  ],
  payments: [{ method: 'UPI', amount: 990, tendered: null, changeGiven: null }],
  branch: {
    id: 'b1',
    restaurantId: 'r1',
    gstNumber: '29ABCDE1234F1Z5',
    taxRegime: 'INDIA_GST',
    taxMode: 'INCLUSIVE',
    taxLabel: null,
    taxId: null,
    restaurant: {
      id: 'r1',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      digitalReceiptsEnabled: true,
    },
  },
};

function setup(
  opts: {
    row?: any;
    enabled?: boolean;
    template?: 'default' | 'off' | 'custom';
    sendError?: Error;
    claimCount?: number;
  } = {},
) {
  const row =
    opts.row === undefined
      ? {
          id: 'x1',
          orderId: 'o1',
          restaurantId: 'r1',
          toEmail: 'asha@example.com',
          status: 'PENDING',
          sendCount: 0,
          consentAt: new Date(),
        }
      : opts.row;
  const prisma: any = {
    order: {
      findFirst: jest.fn().mockResolvedValue({
        ...orderRow,
        branch: {
          ...orderRow.branch,
          restaurant: {
            ...orderRow.branch.restaurant,
            digitalReceiptsEnabled: opts.enabled ?? true,
          },
        },
      }),
    },
    receiptEmail: {
      findUnique: jest.fn().mockResolvedValue(row),
      create: jest.fn().mockResolvedValue(row),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: opts.claimCount ?? 1 }),
      update: jest.fn().mockResolvedValue(row),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    customer: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const send = jest.fn().mockImplementation(() => {
    if (opts.sendError) return Promise.reject(opts.sendError);
    return Promise.resolve();
  });
  const email: any = { isConfigured: () => true, send };
  const compose = (values: Record<string, string>) =>
    renderEmail({
      key: 'RECEIPT',
      template:
        opts.template === 'custom'
          ? {
              ...EMAIL_TEMPLATE_DEFAULTS.RECEIPT,
              subject: 'Custom {{order.number}}',
              heading: 'Custom heading',
            }
          : EMAIL_TEMPLATE_DEFAULTS.RECEIPT,
      branding: {
        primaryColor: '#9F1239',
        headerText: null,
        footerText: null,
        logoUrl: null,
        replyTo: null,
      },
      values: { 'restaurant.name': 'Spice Garden', ...values },
    });
  const templates: any = {
    forBranch: jest
      .fn()
      .mockResolvedValue(opts.template === 'off' ? null : compose),
  };
  const audit: any = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new ReceiptEmailService(prisma, email, templates, audit);
  return { service, prisma, send, templates, audit };
}

describe('ReceiptEmailService.sendAfterPayment', () => {
  it('sends HTML and text with the order figures to the stored address', async () => {
    const { service, send, prisma } = setup();
    await service.sendAfterPayment('o1');
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail.to).toBe('asha@example.com');
    expect(mail.subject).toContain('Your receipt from');
    expect(mail.html).toContain('<html');
    expect(mail.html).toContain('Paneer Tikka');
    expect(mail.text).toContain('Paneer Tikka');
    expect(mail.text).toContain('₹990.00');
    expect(mail.html).toContain('GSTIN: 29ABCDE1234F1Z5');
    expect(prisma.receiptEmail.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT' }),
      }),
    );
  });

  it('uses the restaurant custom wording but keeps the amounts', async () => {
    const { service, send } = setup({ template: 'custom' });
    await service.sendAfterPayment('o1');
    const mail = send.mock.calls[0][0];
    expect(mail.subject).toBe('Custom #1042');
    expect(mail.html).toContain('Custom heading');
    expect(mail.text).toContain('₹990.00');
  });

  it('is idempotent: a second call while the claim is lost sends nothing', async () => {
    const { service, send } = setup({ claimCount: 0 });
    await service.sendAfterPayment('o1');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send an already sent receipt', async () => {
    const { service, send } = setup({
      row: { orderId: 'o1', toEmail: 'a@b.co', status: 'SENT' },
    });
    await service.sendAfterPayment('o1');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing without a consented address on file', async () => {
    const { service, send } = setup({ row: null });
    await service.sendAfterPayment('o1');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing when digital receipts are switched off', async () => {
    const { service, send } = setup({ enabled: false });
    await service.sendAfterPayment('o1');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send automatically when the template is disabled', async () => {
    const { service, send, prisma } = setup({ template: 'off' });
    await service.sendAfterPayment('o1');
    expect(send).not.toHaveBeenCalled();
    expect(prisma.receiptEmail.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SKIPPED' }),
      }),
    );
  });

  it('never throws and logs no address when the transport fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const err = new Error('550 rejected asha@example.com');
    err.name = 'SmtpError';
    const { service, prisma } = setup({ sendError: err });
    await expect(service.sendAfterPayment('o1')).resolves.toBeUndefined();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('SmtpError');
    expect(logged).not.toContain('asha@example.com');
    expect(prisma.receiptEmail.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          lastError: 'SmtpError',
        }),
      }),
    );
    warn.mockRestore();
  });
});

describe('ReceiptEmailService.resend', () => {
  it('resends to the stored address', async () => {
    const { service, send, audit } = setup({
      row: { orderId: 'o1', toEmail: 'asha@example.com', status: 'SENT' },
    });
    const res = await service.resend('r1', 'o1', 'u1');
    expect(res.sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(audit.record.mock.calls);
    expect(logged).toContain('order.receipt_resent');
    expect(logged).not.toContain('asha@example.com');
  });

  it('explains when the template is turned off', async () => {
    const { service, send } = setup({ template: 'off' });
    await expect(service.resend('r1', 'o1', 'u1')).rejects.toThrow(
      ConflictException,
    );
    await expect(service.resend('r1', 'o1', 'u1')).rejects.toThrow(
      /turned off/i,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses when digital receipts are off, no address, or unpaid', async () => {
    await expect(
      setup({ enabled: false }).service.resend('r1', 'o1', 'u1'),
    ).rejects.toThrow(ConflictException);
    await expect(
      setup({ row: null }).service.resend('r1', 'o1', 'u1'),
    ).rejects.toThrow(BadRequestException);
    const s = setup();
    s.prisma.order.findFirst.mockResolvedValue({
      ...orderRow,
      status: 'OPEN',
    });
    await expect(s.service.resend('r1', 'o1', 'u1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('is scoped to the restaurant', async () => {
    const s = setup();
    s.prisma.order.findFirst.mockResolvedValue(null);
    await expect(s.service.resend('other', 'o1', 'u1')).rejects.toThrow(
      NotFoundException,
    );
    expect(s.prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branch: { restaurantId: 'other' },
        }),
      }),
    );
  });

  it('is rate limited per order', async () => {
    const { service } = setup();
    for (let i = 0; i < 3; i++) await service.resend('r1', 'o1', 'u1');
    await expect(service.resend('r1', 'o1', 'u1')).rejects.toThrow(
      HttpException,
    );
  });
});

describe('ReceiptEmailService claim and stuck sends', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  it('does not resend a SENDING row that is still fresh', async () => {
    const { service, send } = setup({
      row: {
        orderId: 'o1',
        toEmail: 'a@b.co',
        status: 'SENDING',
        updatedAt: minutesAgo(1),
      },
    });
    await service.sendAfterPayment('o1');
    expect(send).not.toHaveBeenCalled();
  });

  it('reclaims a row stuck in SENDING for over 10 minutes', async () => {
    const { service, send, prisma } = setup({
      row: {
        orderId: 'o1',
        toEmail: 'a@b.co',
        status: 'SENDING',
        updatedAt: minutesAgo(11),
      },
    });
    await service.sendAfterPayment('o1');
    expect(send).toHaveBeenCalledTimes(1);
    // The claim itself is conditional: stale SENDING rows only.
    const claim = prisma.receiptEmail.updateMany.mock.calls[0][0];
    expect(JSON.stringify(claim.where)).toContain('SENDING');
    expect(JSON.stringify(claim.where)).toContain('updatedAt');
  });

  it('lets a staff resend reclaim a stuck SENDING row', async () => {
    const { service, send } = setup({
      row: {
        orderId: 'o1',
        toEmail: 'a@b.co',
        status: 'SENDING',
        updatedAt: minutesAgo(30),
      },
    });
    await expect(service.resend('r1', 'o1', 'u1')).resolves.toEqual({
      sent: true,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses a resend while another send is fresh', async () => {
    const { service, send } = setup({
      row: {
        orderId: 'o1',
        toEmail: 'a@b.co',
        status: 'SENDING',
        updatedAt: minutesAgo(1),
      },
      claimCount: 0,
    });
    await expect(service.resend('r1', 'o1', 'u1')).rejects.toThrow(
      ConflictException,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('ReceiptEmailService.capture', () => {
  const dto = (o: object = {}) => ({
    receiptEmail: 'asha@example.com',
    receiptEmailConsent: true,
    ...o,
  });
  const input = (o: object = {}) => ({
    orderId: 'o1',
    branchId: 'b1',
    customerId: 'c1',
    dto: dto(),
    ...o,
  });

  it('records the consented address on the customer and never in customer.email', async () => {
    const { service, prisma } = setup();
    prisma.customer.findUnique.mockResolvedValue({
      email: null,
      receiptEmail: null,
      receiptConsentAt: null,
    });
    await service.capture(input());
    expect(prisma.receiptEmail.create).toHaveBeenCalledTimes(1);
    const data = prisma.customer.update.mock.calls[0][0].data;
    expect(data).toEqual(
      expect.objectContaining({ receiptEmail: 'asha@example.com' }),
    );
    expect(data).not.toHaveProperty('email');
  });

  it('records nothing without consent', async () => {
    const { service, prisma } = setup();
    await service.capture(
      input({ customerId: null, dto: dto({ receiptEmailConsent: false }) }),
    );
    await service.capture(
      input({ customerId: null, dto: dto({ receiptEmailConsent: undefined }) }),
    );
    expect(prisma.receiptEmail.create).not.toHaveBeenCalled();
  });

  it('withdrawing consent clears the pending record and the saved address', async () => {
    const { service, prisma } = setup();
    await service.capture(
      input({ dto: dto({ receiptEmailConsent: false }) }),
    );
    expect(prisma.receiptEmail.deleteMany).toHaveBeenCalled();
    expect(prisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { receiptEmail: null, receiptConsentAt: null },
      }),
    );
  });

  it('records a withdrawal even when digital receipts are switched off', async () => {
    const { service, prisma } = setup({ enabled: false });
    await service.capture(
      input({ dto: dto({ receiptEmailConsent: false }) }),
    );
    expect(prisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { receiptEmail: null, receiptConsentAt: null },
      }),
    );
  });

  it('uses only the address the guest consented to, never customer.email', async () => {
    const { service, prisma } = setup();
    prisma.customer.findUnique.mockResolvedValue({
      email: 'old-or-typo@example.com',
      receiptEmail: 'consented@example.com',
      receiptConsentAt: new Date(),
    });
    await service.capture(input({ dto: {} }));
    expect(prisma.receiptEmail.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ toEmail: 'consented@example.com' }),
    });
  });

  it('sends nothing for a customer who has an email but never consented', async () => {
    const { service, prisma } = setup();
    prisma.customer.findUnique.mockResolvedValue({
      email: 'staff-typed@example.com',
      receiptEmail: null,
      receiptConsentAt: null,
    });
    await service.capture(input({ dto: {} }));
    expect(prisma.receiptEmail.create).not.toHaveBeenCalled();
  });

  it('records nothing new when digital receipts are switched off', async () => {
    const { service, prisma } = setup({ enabled: false });
    await service.capture(input());
    expect(prisma.receiptEmail.create).not.toHaveBeenCalled();
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it('writes atomically: a lost create race updates only unclaimed rows', async () => {
    const { service, prisma } = setup();
    prisma.receiptEmail.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    await service.capture(input());
    const args = prisma.receiptEmail.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({
      orderId: 'o1',
      status: { in: ['PENDING', 'FAILED', 'SKIPPED'] },
    });
    expect(args.data).toEqual(
      expect.objectContaining({ toEmail: 'asha@example.com' }),
    );
  });
});
