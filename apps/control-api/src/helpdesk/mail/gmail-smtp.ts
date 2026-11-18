import { createTransport, type SendMailOptions, type SMTPTransportOptions } from 'nodemailer';
import { z } from 'zod';
import { readGmailConfig } from './gmail-config.js';
import { normalizeThreadIdentity } from './thread-identity.js';

const messageId = z.string().max(254).refine(
  (value) => normalizeThreadIdentity({ messageId: value }).messageId === value,
);
const replySchema = z.strictObject({
  to: z.string().max(254).pipe(z.email()),
  // eslint-disable-next-line no-control-regex
  subject: z.string().min(1).max(250).regex(/^[^\u0000-\u001f\u007f\u0085\u2028\u2029]+$/),
  messageId,
  inReplyTo: messageId.optional(),
  text: z.string().min(1).max(65_536),
  html: z.string().min(1).max(524_288),
});

const deliveryReceipt = z.object({
  accepted: z.tuple([z.string()]),
  rejected: z.array(z.string()).length(0),
  messageId: z.string(),
  response: z.string().regex(/^250(?:[ -]|$)/),
});
const smtpRejection = z.object({
  code: z.enum(['EAUTH', 'EENVELOPE', 'EMESSAGE']),
  command: z.string(),
  responseCode: z.number().int().min(400).max(599),
  response: z.string(),
});

export type GmailSmtpFactory = (options: SMTPTransportOptions) => {
  sendMail: (message: SendMailOptions) => Promise<unknown>;
};
export type GmailSendOutcome =
  | { status: 'sent'; messageId: string }
  | { status: 'rejected'; responseCode: number; retryable: boolean }
  | { status: 'ambiguous' }
  | { status: 'invalid' };

function classifyFailure(error: unknown): GmailSendOutcome {
  const parsed = smtpRejection.safeParse(error);
  if (parsed.success) {
    const { code, command, responseCode, response } = parsed.data;
    const rejection = response.match(/^([45][0-9]{2})(?:[ -]|$)/);
    const recognizedStage =
      (code === 'EAUTH' && /^AUTH [A-Z0-9-]+$/i.test(command)) ||
      (code === 'EENVELOPE' && ['MAIL FROM', 'RCPT TO', 'DATA'].includes(command)) ||
      (code === 'EMESSAGE' && command === 'DATA');
    if (recognizedStage && Number(rejection?.[1]) === responseCode) {
      return { status: 'rejected', responseCode, retryable: responseCode < 500 };
    }
  }
  return { status: 'ambiguous' };
}

/** Delivery only. Accepts one verified destination and server-rendered content. */
export function createGmailSmtp(
  env: NodeJS.ProcessEnv,
  create: GmailSmtpFactory = (options) => createTransport(options),
) {
  const { user, pass } = readGmailConfig(env);
  let transport: ReturnType<GmailSmtpFactory>;
  try {
    transport = create({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'smtp.gmail.com' },
      auth: { user, pass },
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  } catch {
    throw new Error('Unable to initialize Gmail SMTP transport');
  }

  return {
    async send(input: unknown): Promise<GmailSendOutcome> {
      const parsed = replySchema.safeParse(input);
      if (!parsed.success) return { status: 'invalid' };
      const { to, messageId, inReplyTo, subject, text, html } = parsed.data;
      try {
        const info = deliveryReceipt.safeParse(await transport.sendMail({
          envelope: { from: user, to: [to] },
          from: { name: 'Nventra Support', address: user },
          to: { name: '', address: to },
          messageId,
          inReplyTo,
          references: inReplyTo,
          subject,
          text,
          html,
        }));
        if (info.success && info.data.accepted[0] === to && info.data.messageId === messageId) {
          return { status: 'sent', messageId };
        }
        return { status: 'ambiguous' };
      } catch (error) {
        return classifyFailure(error);
      }
    },
  };
}
