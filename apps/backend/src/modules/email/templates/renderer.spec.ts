import {
  DEFAULT_EMAIL_PRIMARY_COLOR,
  EMAIL_TEMPLATE_KEYS,
  emailTemplateUpdateSchema,
  unknownEmailPlaceholders,
  isAllowedTemplateLink,
  isSafeEmailLink,
} from '@nventra/types';
import { EMAIL_SAMPLE_DATA, EMAIL_TEMPLATE_DEFAULTS } from './defaults';
import { renderEmail, type RenderInput } from './renderer';

const branding = {
  primaryColor: DEFAULT_EMAIL_PRIMARY_COLOR,
  headerText: null,
  footerText: null,
  logoUrl: null,
  replyTo: null,
};

const base = (over: Partial<RenderInput> = {}): RenderInput => ({
  key: 'PASSWORD_RESET',
  template: EMAIL_TEMPLATE_DEFAULTS.PASSWORD_RESET,
  branding,
  values: EMAIL_SAMPLE_DATA.PASSWORD_RESET,
  ...over,
});

describe('renderEmail layout', () => {
  const out = renderEmail(base());

  it('is a complete, self-contained, responsive HTML document', () => {
    expect(out.html).toMatch(/^<!DOCTYPE html>/);
    expect(out.html).toContain('<html lang="en"');
    expect(out.html).toContain('name="viewport"');
    expect(out.html).toContain('max-width:600px');
    expect(out.html).toContain('@media only screen and (max-width:620px)');
    expect(out.html).toContain('name="color-scheme"');
    expect(out.html).not.toMatch(/<script|<link\b|javascript:/i);
  });

  it('shows the restaurant name in a header band in the brand colour', () => {
    expect(out.html).toContain(
      `background-color:${DEFAULT_EMAIL_PRIMARY_COLOR}`,
    );
    expect(out.html).toContain(
      EMAIL_SAMPLE_DATA.PASSWORD_RESET['restaurant.name'],
    );
  });

  it('uses an accessible h1 heading and a 16px body', () => {
    expect(out.html).toMatch(/<h1 [^>]*>Reset your password<\/h1>/);
    expect(out.html).toContain('font-size:16px');
  });

  it('renders a table-based bulletproof button with the link', () => {
    expect(out.html).toContain('role="presentation"');
    expect(out.html).toContain(
      `href="${EMAIL_SAMPLE_DATA.PASSWORD_RESET['reset.url']}"`,
    );
    expect(out.html).toContain('Reset password');
  });

  it('puts the restaurant address in the footer', () => {
    expect(out.html).toContain(
      EMAIL_SAMPLE_DATA.PASSWORD_RESET['restaurant.address'],
    );
  });

  it('uses white or dark button text depending on the brand colour', () => {
    const light = renderEmail(
      base({ branding: { ...branding, primaryColor: '#FDE68A' } }),
    );
    expect(light.html).toContain('color:#111827;text-decoration:none');
    expect(out.html).toContain('color:#ffffff;text-decoration:none');
  });

  it('shows the logo with alt text only when set', () => {
    expect(out.html).not.toContain('<img');
    const withLogo = renderEmail(
      base({
        branding: { ...branding, logoUrl: 'https://cdn.test/logo.png' },
      }),
    );
    expect(withLogo.html).toMatch(
      /<img src="https:\/\/cdn\.test\/logo\.png" alt="[^"]+"/,
    );
  });

  it('uses the branding header text and footer text', () => {
    const b = renderEmail(
      base({
        branding: {
          ...branding,
          headerText: 'Café <Rosa>',
          footerText: 'Call **us**',
        },
      }),
    );
    expect(b.html).toContain('Café &lt;Rosa&gt;');
    expect(b.html).toContain('Call <strong>us</strong>');
    expect(b.text).toContain('Call us');
  });

  it('drops the button when its resolved link is unsafe', () => {
    const b = renderEmail(
      base({
        values: {
          ...EMAIL_SAMPLE_DATA.PASSWORD_RESET,
          'reset.url': 'javascript:alert(1)',
        },
      }),
    );
    expect(b.html).not.toContain('javascript');
    expect(b.html).not.toContain('Reset password</a>');
  });
});

describe('renderEmail escaping', () => {
  it('escapes placeholder values in subject, heading, body and footer', () => {
    const evil = '<script>alert(1)</script>';
    const out = renderEmail(
      base({
        values: {
          ...EMAIL_SAMPLE_DATA.PASSWORD_RESET,
          'user.name': evil,
          'restaurant.name': evil,
        },
        template: {
          ...EMAIL_TEMPLATE_DEFAULTS.PASSWORD_RESET,
          subject: 'Hi {{user.name}}',
          heading: 'Hi {{user.name}}',
          footer: '{{restaurant.name}}',
        },
      }),
    );
    expect(out.html).not.toContain('<script>');
    expect(out.subject).toBe(`Hi ${evil}`);
    expect(out.text).toContain(`Hi ${evil}`);
  });

  it('keeps subjects on one line', () => {
    const out = renderEmail(
      base({
        template: {
          ...EMAIL_TEMPLATE_DEFAULTS.PASSWORD_RESET,
          subject: '{{user.name}}',
        },
        values: {
          ...EMAIL_SAMPLE_DATA.PASSWORD_RESET,
          'user.name': 'a\r\nBcc: x@y.z',
        },
      }),
    );
    expect(out.subject).toBe('a Bcc: x@y.z');
  });
});

describe('renderEmail plain-text alternative', () => {
  it('has heading, body, button link and footer, and no HTML', () => {
    const out = renderEmail(base());
    expect(out.text).toContain('Reset your password');
    expect(out.text).toContain(
      `Reset password: ${EMAIL_SAMPLE_DATA.PASSWORD_RESET['reset.url']}`,
    );
    expect(out.text).toContain(
      EMAIL_SAMPLE_DATA.PASSWORD_RESET['restaurant.address'],
    );
    expect(out.text).not.toMatch(/<[a-z]/i);
  });
});

describe('marketing unsubscribe', () => {
  const values = {
    ...EMAIL_SAMPLE_DATA.MARKETING_CAMPAIGN,
    'unsubscribe.url': 'https://pos.test/api/v1/public/unsubscribe/tok',
  };
  it('always includes the unsubscribe link, even if the footer omits it', () => {
    const out = renderEmail({
      key: 'MARKETING_CAMPAIGN',
      template: { ...EMAIL_TEMPLATE_DEFAULTS.MARKETING_CAMPAIGN, footer: null },
      branding,
      values,
    });
    expect(out.html).toContain(
      'href="https://pos.test/api/v1/public/unsubscribe/tok"',
    );
    expect(out.html).toContain('Unsubscribe');
    expect(out.text).toContain(
      'Unsubscribe: https://pos.test/api/v1/public/unsubscribe/tok',
    );
  });
  it('is not added to other emails', () => {
    expect(renderEmail(base()).html).not.toContain('Unsubscribe');
  });
});

describe('defaults for all 6 keys', () => {
  it.each(EMAIL_TEMPLATE_KEYS)(
    '%s has a valid default and sample data',
    (key) => {
      const t = EMAIL_TEMPLATE_DEFAULTS[key];
      expect(emailTemplateUpdateSchema.safeParse(t).success).toBe(true);
      expect(
        unknownEmailPlaceholders(key, [
          t.subject,
          t.heading,
          t.body,
          t.buttonText,
          t.buttonUrl,
          t.footer,
        ]),
      ).toEqual([]);
      const out = renderEmail({
        key,
        template: t,
        branding,
        values: EMAIL_SAMPLE_DATA[key],
      });
      expect(out.subject.length).toBeGreaterThan(0);
      expect(out.html).not.toMatch(/\{\{\s*[\w.]+\s*\}\}/);
      expect(out.text).not.toMatch(/\{\{|\}\}/);
      expect(out.text.length).toBeGreaterThan(20);
    },
  );
});

describe('placeholder whitelist and link filter (shared helpers)', () => {
  it('reports unknown placeholders for a key', () => {
    expect(
      unknownEmailPlaceholders('REPORT_SCHEDULED', [
        'Hi {{customer.name}} {{report.title}} {{ restaurant.name }}',
        '{{constructor}}',
        null,
      ]),
    ).toEqual(['constructor', 'customer.name']);
    expect(
      unknownEmailPlaceholders('MARKETING_CAMPAIGN', ['{{customer.name}}']),
    ).toEqual([]);
  });

  it('accepts only http(s) and mailto links', () => {
    expect(isSafeEmailLink('https://a.test/x')).toBe(true);
    expect(isSafeEmailLink('http://a.test')).toBe(true);
    expect(isSafeEmailLink('mailto:a@b.co')).toBe(true);
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,1',
      'ftp://a.test',
      '/relative',
      'https://a.test/ x',
      'https://a.test/\u0000',
      '',
    ])
      expect(isSafeEmailLink(bad)).toBe(false);
  });

  it('accepts template links that start with a placeholder', () => {
    expect(isAllowedTemplateLink('{{reset.url}}')).toBe(true);
    expect(isAllowedTemplateLink('{{app.url}}/inventory')).toBe(true);
    expect(isAllowedTemplateLink('javascript:{{app.url}}')).toBe(false);
  });

  it('only lets URL placeholders (*.url) start a link', () => {
    expect(isAllowedTemplateLink('{{customer.name}}')).toBe(false);
    expect(isAllowedTemplateLink('{{campaign.message}}/x')).toBe(false);
    expect(isAllowedTemplateLink('{{ unsubscribe.url }}')).toBe(true);
    expect(
      emailTemplateUpdateSchema.safeParse({
        ...EMAIL_TEMPLATE_DEFAULTS.RECEIPT,
        body: '[Open]({{customer.name}})',
      }).success,
    ).toBe(false);
  });

  it('never turns a non-URL placeholder value into a link at render time', () => {
    const out = renderEmail(
      base({
        template: {
          ...EMAIL_TEMPLATE_DEFAULTS.PASSWORD_RESET,
          body: '[Open]({{user.name}})',
          buttonUrl: '{{user.name}}',
        },
        values: {
          ...EMAIL_SAMPLE_DATA.PASSWORD_RESET,
          'user.name': 'https://evil.example',
        },
      }),
    );
    expect(out.html).not.toContain('href="https://evil.example"');
    expect(out.text).not.toContain('Open (https://evil.example)');
  });

  it('rejects unsafe links in body and button on save', () => {
    const t = EMAIL_TEMPLATE_DEFAULTS.RECEIPT;
    expect(
      emailTemplateUpdateSchema.safeParse({
        ...t,
        body: '[x](javascript:alert(1))',
      }).success,
    ).toBe(false);
    expect(
      emailTemplateUpdateSchema.safeParse({
        ...t,
        buttonUrl: 'data:text/html,x',
      }).success,
    ).toBe(false);
    expect(
      emailTemplateUpdateSchema.safeParse({
        ...t,
        buttonUrl: null,
        buttonText: 'Go',
      }).success,
    ).toBe(false);
  });
});
