import type { EmailTemplateKey } from '@nventra/types';
import type { TemplateValues } from './markdown';

/** The editable parts of one email. */
export interface EmailTemplateFields {
  subject: string;
  heading: string;
  body: string;
  buttonText: string | null;
  buttonUrl: string | null;
  footer: string | null;
  enabled: boolean;
}

const fields = (
  f: Omit<
    EmailTemplateFields,
    'enabled' | 'buttonText' | 'buttonUrl' | 'footer'
  > &
    Partial<EmailTemplateFields>,
): EmailTemplateFields => ({
  buttonText: null,
  buttonUrl: null,
  footer: null,
  enabled: true,
  ...f,
});

/**
 * Code-defined defaults, used whenever a restaurant has not saved its own
 * version. The three existing senders keep their previous wording.
 */
export const EMAIL_TEMPLATE_DEFAULTS: Readonly<
  Record<EmailTemplateKey, EmailTemplateFields>
> = {
  MARKETING_CAMPAIGN: fields({
    subject: '{{campaign.name}}',
    heading: '{{campaign.name}}',
    body: '{{campaign.message}}',
    footer:
      'You are receiving this because you are a customer of {{restaurant.name}}.',
  }),
  REPORT_SCHEDULED: fields({
    subject: '{{report.title}} · {{report.period}}',
    heading: 'Your {{report.title}} report',
    body: 'Your scheduled **{{report.title}}** report for {{report.from}} to {{report.to}} is attached.',
    footer: 'Sent by Nventra POS for {{restaurant.name}}.',
  }),
  STOCK_ALERT: fields({
    subject: 'Stock alert: expiring or low items',
    heading: 'Stock alert',
    body: '{{alert.summary}}\n\n{{alert.details}}',
    buttonText: 'Open inventory',
    buttonUrl: '{{app.url}}/inventory',
    footer: 'Sent by Nventra POS for {{restaurant.name}}.',
  }),
  RECEIPT: fields({
    subject: 'Your receipt from {{restaurant.name}}',
    heading: 'Thanks for your order, {{customer.name}}',
    body: 'Order **{{order.number}}** on {{order.date}}\n\nTotal paid: **{{order.total}}**\n\nWe hope to see you again soon.',
    buttonText: 'View receipt',
    buttonUrl: '{{receipt.url}}',
  }),
  STAFF_INVITE: fields({
    subject: "You're invited to join {{restaurant.name}}",
    heading: 'Welcome to the team, {{staff.name}}',
    body: 'You have been invited to join **{{restaurant.name}}** on Nventra POS as {{invite.role}}.\n\nUse the button below to set your password and sign in.',
    buttonText: 'Accept invitation',
    buttonUrl: '{{invite.url}}',
    footer:
      "If you weren't expecting this invitation, you can ignore this email.",
  }),
  PASSWORD_RESET: fields({
    subject: 'Reset your password',
    heading: 'Reset your password',
    body: "Hi {{user.name}},\n\nWe received a request to reset your password. This link expires in {{reset.expiresIn}}.\n\nIf you didn't ask for this, you can safely ignore this email.",
    buttonText: 'Reset password',
    buttonUrl: '{{reset.url}}',
  }),
};

const COMMON_SAMPLE = {
  'restaurant.name': 'Spice Garden',
  'restaurant.address': '12 MG Road, Indiranagar, Bengaluru 560038',
  'app.url': 'https://pos.example.com',
};

/** Realistic example values for previews and test sends. */
export const EMAIL_SAMPLE_DATA: Readonly<
  Record<EmailTemplateKey, TemplateValues>
> = {
  MARKETING_CAMPAIGN: {
    ...COMMON_SAMPLE,
    'customer.name': 'Asha Rao',
    'campaign.name': 'Weekend special: 20% off biryani',
    'campaign.message':
      'This weekend only, enjoy 20% off every biryani on the menu.\n\nShow this email at the counter or order online. See you soon!',
    'unsubscribe.url':
      'https://pos.example.com/api/v1/public/unsubscribe/sample',
  },
  REPORT_SCHEDULED: {
    ...COMMON_SAMPLE,
    'report.title': 'Daily Sales Summary',
    'report.period': '2026-11-15',
    'report.from': '2026-11-15',
    'report.to': '2026-11-15',
  },
  STOCK_ALERT: {
    ...COMMON_SAMPLE,
    'alert.summary': '2 items are expiring soon and 1 is low on stock.',
    'alert.details':
      'Expiring soon:\nMilk (batch B12, 4 left) expires 2026-11-17\nPaneer (batch P3, 2 left) expires 2026-11-18\n\nLow stock:\nBasmati rice: 3 left (reorder at 10)',
  },
  RECEIPT: {
    ...COMMON_SAMPLE,
    'customer.name': 'Asha Rao',
    'order.number': '#1042',
    'order.date': '15 Nov 2026, 8:42 pm',
    'order.total': '₹1,250.00',
    'receipt.url': 'https://pos.example.com/r/sample',
  },
  STAFF_INVITE: {
    ...COMMON_SAMPLE,
    'staff.name': 'Ravi Kumar',
    'invite.role': 'Cashier',
    'invite.url': 'https://pos.example.com/invite/sample',
  },
  PASSWORD_RESET: {
    ...COMMON_SAMPLE,
    'user.name': 'Ravi Kumar',
    'reset.url': 'https://pos.example.com/reset-password/sample',
    'reset.expiresIn': '30 minutes',
  },
};
