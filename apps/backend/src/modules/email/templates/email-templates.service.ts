import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailBranding, EmailTemplate } from '@prisma/client';
import {
  COMMON_EMAIL_PLACEHOLDERS,
  DEFAULT_EMAIL_PRIMARY_COLOR,
  EMAIL_TEMPLATE_KEYS,
  allowedEmailPlaceholders,
  unknownEmailPlaceholders,
  type EmailBrandingDto,
  type EmailBrandingView,
  type EmailPreviewView,
  type EmailTemplateKey,
  type EmailTemplateUpdateDto,
  type EmailTemplateView,
} from '@nventra/types';
import { KeyRateLimiter } from '../../../common/guards/key-rate-limiter';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmailService } from '../email.service';
import {
  EMAIL_SAMPLE_DATA,
  EMAIL_TEMPLATE_DEFAULTS,
  type EmailTemplateFields,
} from './defaults';
import type { TemplateValues } from './markdown';
import { renderEmail, type RenderedEmail } from './renderer';

/** Renders one kind of email for one restaurant; null when it is turned off. */
export type EmailComposer = (
  values: TemplateValues,
) => RenderedEmail & { replyTo?: string };

const COMMON_NAMES = new Set<string>(COMMON_EMAIL_PLACEHOLDERS);
const TEST_SENDS_PER_WINDOW = 5;
const TEST_WINDOW_MS = 10 * 60_000;

interface RestaurantContext {
  restaurantId: string;
  name: string;
  address: string;
}

function toFields(row: EmailTemplate): EmailTemplateFields {
  return {
    subject: row.subject,
    heading: row.heading,
    body: row.body,
    buttonText: row.buttonText,
    buttonUrl: row.buttonUrl,
    footer: row.footer,
    enabled: row.enabled,
  };
}

function toBrandingView(row: EmailBranding | null): EmailBrandingView {
  return {
    primaryColor: row?.primaryColor ?? DEFAULT_EMAIL_PRIMARY_COLOR,
    headerText: row?.headerText ?? null,
    footerText: row?.footerText ?? null,
    logoUrl: row?.logoUrl ?? null,
    replyTo: row?.replyTo ?? null,
  };
}

const blankToNull = (v: string | null | undefined) => (v?.trim() ? v : null);

@Injectable()
export class EmailTemplatesService {
  private readonly logger = new Logger(EmailTemplatesService.name);
  private readonly testLimiter = new KeyRateLimiter(TEST_WINDOW_MS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  private get appUrl(): string {
    return (
      this.config.get<string>('PUBLIC_URL') || 'http://localhost:1995'
    ).replace(/\/+$/, '');
  }

  private view(
    key: EmailTemplateKey,
    row: EmailTemplate | undefined,
  ): EmailTemplateView {
    const fields = row ? toFields(row) : EMAIL_TEMPLATE_DEFAULTS[key];
    return {
      key,
      ...fields,
      isCustom: !!row,
      placeholders: allowedEmailPlaceholders(key),
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  async list(restaurantId: string): Promise<EmailTemplateView[]> {
    const rows = await this.prisma.emailTemplate.findMany({
      where: { restaurantId },
    });
    return EMAIL_TEMPLATE_KEYS.map((key) =>
      this.view(
        key,
        rows.find((r) => r.key === key),
      ),
    );
  }

  async get(
    restaurantId: string,
    key: EmailTemplateKey,
  ): Promise<EmailTemplateView> {
    const row = await this.prisma.emailTemplate.findUnique({
      where: { restaurantId_key: { restaurantId, key } },
    });
    return this.view(key, row ?? undefined);
  }

  /** Throws 400 listing any placeholder `key` does not support. */
  private assertPlaceholders(
    key: EmailTemplateKey,
    dto: EmailTemplateUpdateDto,
  ) {
    const unknown = unknownEmailPlaceholders(key, [
      dto.subject,
      dto.heading,
      dto.body,
      dto.buttonText,
      dto.buttonUrl,
      dto.footer,
    ]);
    if (unknown.length)
      throw new BadRequestException(
        `Unknown placeholder(s): ${unknown.map((n) => `{{${n}}}`).join(', ')}. Allowed: ${allowedEmailPlaceholders(
          key,
        )
          .map((n) => `{{${n}}}`)
          .join(', ')}`,
      );
  }

  private normalise(dto: EmailTemplateUpdateDto) {
    return {
      subject: dto.subject,
      heading: dto.heading ?? '',
      body: dto.body ?? '',
      buttonText: blankToNull(dto.buttonText),
      buttonUrl: blankToNull(dto.buttonUrl),
      footer: blankToNull(dto.footer),
      enabled: dto.enabled ?? true,
    };
  }

  async update(
    restaurantId: string,
    userId: string,
    key: EmailTemplateKey,
    dto: EmailTemplateUpdateDto,
  ): Promise<EmailTemplateView> {
    this.assertPlaceholders(key, dto);
    const data = { ...this.normalise(dto), updatedBy: userId };
    const row = await this.prisma.emailTemplate.upsert({
      where: { restaurantId_key: { restaurantId, key } },
      create: { restaurantId, key, ...data },
      update: data,
    });
    return this.view(key, row);
  }

  async reset(
    restaurantId: string,
    key: EmailTemplateKey,
  ): Promise<EmailTemplateView> {
    await this.prisma.emailTemplate.deleteMany({
      where: { restaurantId, key },
    });
    return this.view(key, undefined);
  }

  async getBranding(restaurantId: string): Promise<EmailBrandingView> {
    return toBrandingView(
      await this.prisma.emailBranding.findUnique({ where: { restaurantId } }),
    );
  }

  async updateBranding(
    restaurantId: string,
    userId: string,
    dto: EmailBrandingDto,
  ): Promise<EmailBrandingView> {
    const data = {
      primaryColor: dto.primaryColor.toUpperCase(),
      headerText: blankToNull(dto.headerText),
      footerText: blankToNull(dto.footerText),
      logoUrl: blankToNull(dto.logoUrl),
      replyTo: blankToNull(dto.replyTo),
      updatedBy: userId,
    };
    const row = await this.prisma.emailBranding.upsert({
      where: { restaurantId },
      create: { restaurantId, ...data },
      update: data,
    });
    return toBrandingView(row);
  }

  private async restaurantContext(
    restaurantId: string,
  ): Promise<RestaurantContext> {
    const r = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: {
        name: true,
        branches: {
          select: { address: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });
    return {
      restaurantId,
      name: r.name,
      address: r.branches[0]?.address ?? '',
    };
  }

  private async branchContext(
    branchId: string,
  ): Promise<RestaurantContext | null> {
    const b = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        address: true,
        restaurant: { select: { id: true, name: true } },
      },
    });
    return b
      ? {
          restaurantId: b.restaurant.id,
          name: b.restaurant.name,
          address: b.address ?? '',
        }
      : null;
  }

  private async composerFor(
    ctx: RestaurantContext,
    key: EmailTemplateKey,
    override?: EmailTemplateFields,
  ): Promise<EmailComposer | null> {
    const [row, brandingRow] = await Promise.all([
      override
        ? null
        : this.prisma.emailTemplate.findUnique({
            where: {
              restaurantId_key: { restaurantId: ctx.restaurantId, key },
            },
          }),
      this.prisma.emailBranding.findUnique({
        where: { restaurantId: ctx.restaurantId },
      }),
    ]);
    const template =
      override ?? (row ? toFields(row) : EMAIL_TEMPLATE_DEFAULTS[key]);
    if (!template.enabled && !override) return null;
    const branding = toBrandingView(brandingRow);
    const common = {
      'restaurant.name': ctx.name,
      'restaurant.address': ctx.address,
      'app.url': this.appUrl,
    };
    return (values) => ({
      ...renderEmail({
        key,
        template,
        branding,
        values: { ...common, ...values },
      }),
      ...(branding.replyTo ? { replyTo: branding.replyTo } : {}),
    });
  }

  /**
   * Composer for a branch's restaurant (used by the senders). Returns null
   * when the restaurant turned this email off or the branch is gone.
   */
  async forBranch(
    branchId: string,
    key: EmailTemplateKey,
  ): Promise<EmailComposer | null> {
    const ctx = await this.branchContext(branchId);
    return ctx ? this.composerFor(ctx, key) : null;
  }

  private async previewComposer(
    restaurantId: string,
    key: EmailTemplateKey,
    draft?: EmailTemplateUpdateDto,
  ): Promise<EmailComposer> {
    if (draft) this.assertPlaceholders(key, draft);
    const ctx = await this.restaurantContext(restaurantId);
    const fields: EmailTemplateFields = draft
      ? this.normalise(draft)
      : await this.get(restaurantId, key);
    // With an override the composer is never null (disabled templates preview too).
    return (await this.composerFor(ctx, key, fields)) as EmailComposer;
  }

  /** Renders a template (saved, default, or an unsaved draft) with sample data. */
  async preview(
    restaurantId: string,
    key: EmailTemplateKey,
    draft?: EmailTemplateUpdateDto,
  ): Promise<EmailPreviewView> {
    const compose = await this.previewComposer(restaurantId, key, draft);
    // The restaurant's own name, address and app URL replace the sample ones.
    const sample = Object.fromEntries(
      Object.entries(EMAIL_SAMPLE_DATA[key]).filter(
        ([name]) => !COMMON_NAMES.has(name),
      ),
    );
    const { subject, html, text } = compose(sample);
    return { subject, html, text };
  }

  /** Sends the preview to one address. Limited per restaurant. */
  async sendTest(
    restaurantId: string,
    key: EmailTemplateKey,
    to: string,
    draft?: EmailTemplateUpdateDto,
  ): Promise<{ sent: true }> {
    if (!this.email.isConfigured())
      throw new BadRequestException(
        'Email is not set up on this server (SMTP_URL / SMTP_FROM)',
      );
    const wait = this.testLimiter.hit(restaurantId, TEST_SENDS_PER_WINDOW);
    if (wait > 0)
      throw new HttpException(
        `Too many test emails. Try again in ${Math.ceil(wait / 60)} minute(s).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const p = await this.preview(restaurantId, key, draft);
    const branding = await this.getBranding(restaurantId);
    try {
      await this.email.send({
        to,
        subject: `[Test] ${p.subject}`,
        html: p.html,
        text: p.text,
        ...(branding.replyTo ? { replyTo: branding.replyTo } : {}),
      });
    } catch (err) {
      // SMTP errors can echo the recipient address, so log only the error kind.
      this.logger.warn(
        `Test email (${key}) for restaurant ${restaurantId} failed: ${err instanceof Error ? err.name : 'unknown error'}`,
      );
      throw new BadRequestException(
        'The test email could not be sent. Check the server email settings.',
      );
    }
    return { sent: true };
  }
}
