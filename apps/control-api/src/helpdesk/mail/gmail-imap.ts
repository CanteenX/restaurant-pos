import { ImapFlow, type DownloadMeta, type FetchMessageObject, type FetchQueryObject, type ImapFlowOptions, type MailboxObject } from 'imapflow';
import type { Readable } from 'node:stream';
import { readGmailConfig } from './gmail-config.js';
import { checkInboundMailBudget, classifyInboundMail, INBOUND_MAIL_BUDGETS, type InboundMailDisposition } from './inbound-policy.js';

type Cursor = { uidValidity?: string; afterUid: number };
type Structure = NonNullable<FetchMessageObject['bodyStructure']>;
type MessageResult = InboundMailDisposition | {
  disposition: 'quarantine';
  reason: 'missing-metadata' | 'missing-plaintext' | 'ambiguous-plaintext' | 'invalid-text';
};
type Envelope = Pick<NonNullable<FetchMessageObject['envelope']>, 'from' | 'subject' | 'messageId' | 'inReplyTo'>;
type Message = { uid: number; providerId: string; result: MessageResult; text?: string; envelope?: Envelope; headers?: Buffer };
type Batch = { status: 'resync'; uidValidity: string } | {
  status: 'batch'; uidValidity: string; throughUid: number; messages: Message[];
};
type Client = {
  on(event: 'error', listener: (error: Error) => void): unknown;
  connect(): Promise<void>;
  mailboxOpen(path: 'INBOX', options: { readOnly: true }): Promise<Pick<MailboxObject, 'uidValidity' | 'uidNext'>>;
  fetchAll(range: string, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject[]>;
  fetchOne(uid: number, query: FetchQueryObject, options: { uid: true }): Promise<FetchMessageObject | false | undefined>;
  download(uid: number, part: string, options: { uid: true; maxBytes: number; chunkSize: number; decodeText: false }): Promise<{ meta?: DownloadMeta; content?: Readable }>;
  close(): void;
};
export type GmailImapFactory = (options: ImapFlowOptions) => Client;

const inUidRange = (value: number, min: number) =>
  Number.isInteger(value) && value >= min && value <= 0xffff_ffff;
const validEpoch = (value: string) =>
  typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && inUidRange(Number(value), 1);
// ImapFlow reports either the server EMAILID or the Gmail X-GM-MSGID in emailId.
const validProviderId = (value: string | undefined): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(value);
const uidMode = { uid: true } as const;
const sizeQuery = { uid: true, size: true, emailId: true } as const;

function inspect(root: Structure) {
  const parts: string[] = [];
  let mimeParts = 0;
  let mimeDepth = 0;
  let attachmentCount = 0;
  const pending = [{ node: root, path: '', depth: 1, hidden: false }];
  while (pending.length) {
    const { node, path, depth, hidden } = pending.pop()!;
    mimeDepth = Math.max(mimeDepth, depth);
    const rejection = checkInboundMailBudget('mimeParts', ++mimeParts)
      ?? checkInboundMailBudget('mimeDepth', mimeDepth);
    if (rejection) return { rejection };
    const type = node.type.toLowerCase();
    const attached = hidden || node.parameters?.name !== undefined || node.dispositionParameters?.filename !== undefined ||
      (typeof node.disposition === 'string' && node.disposition.toLowerCase() !== 'inline') ||
      (!type.startsWith('multipart/') && type !== 'text/plain' && type !== 'text/html');
    const children = node.childNodes ?? [];
    const remaining = checkInboundMailBudget('mimeParts', mimeParts + children.length + pending.length);
    if (remaining) return { rejection: remaining };
    if (children.length) {
      children.forEach((child, index) => pending.push({
        node: child, path: path ? path + '.' + (index + 1) : String(index + 1), depth: depth + 1, hidden: attached,
      }));
    } else if (attached) {
      attachmentCount++;
    } else if (type === 'text/plain') {
      parts.push(path || '1');
    }
  }
  return { parts, mimeParts, mimeDepth, attachmentCount };
}

async function abortable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let stop: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(new Error('Gmail inbox retrieval failed'));
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([aborted, operation()]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

async function readMessage(
  client: Client, uid: number, providerId: string, wireBytes: number, signal: AbortSignal,
): Promise<Message> {
  const identity = { uid, providerId };
  const wireRejection = checkInboundMailBudget('wireBytes', wireBytes);
  if (wireRejection) return { ...identity, result: wireRejection };
  if (!wireBytes) return { ...identity, result: { disposition: 'quarantine', reason: 'invalid-measurement', measurement: 'wireBytes' } };

  const started = performance.now();
  const message = await client.fetchOne(uid, {
    ...sizeQuery, bodyStructure: true, envelope: true, labels: true,
    headers: ['references', 'auto-submitted', 'list-id'],
  }, uidMode);
  signal.throwIfAborted();
  if (!message || !message.bodyStructure) return { ...identity, result: { disposition: 'quarantine', reason: 'missing-metadata' } };
  if (message.uid !== uid || message.emailId !== providerId || message.size !== wireBytes) throw new Error('Inconsistent message metadata');

  const structure = inspect(message.bodyStructure);
  if (structure.rejection) return { ...identity, result: structure.rejection };
  const { parts, mimeParts, mimeDepth, attachmentCount } = structure;
  const flags = {
    providerSpam: message.labels?.has('\\Spam'),
    deliveryReport: message.bodyStructure.type.toLowerCase() === 'multipart/report',
  };
  const measured = (decodedTextBytes: number) => ({
    wireBytes, decodedTextBytes, mimeParts, mimeDepth, attachmentCount,
    processingMs: Math.ceil(performance.now() - started),
  });
  const preflight = classifyInboundMail(flags, measured(0));
  if (preflight.disposition !== 'accept') return { ...identity, result: preflight };
  if (parts.length !== 1) return { ...identity, result: {
    disposition: 'quarantine', reason: parts.length ? 'ambiguous-plaintext' : 'missing-plaintext',
  } };

  const { meta, content } = await client.download(uid, parts[0], {
    // Stream transfer-decoded bytes. Charset/format stages in the SDK can truncate before output.
    uid: true, maxBytes: INBOUND_MAIL_BUDGETS.decodedTextBytes + 1, chunkSize: 16_384, decodeText: false,
  });
  if (!content) return { ...identity, result: { disposition: 'quarantine', reason: 'missing-metadata' } };
  const stop = () => { content.destroy(); };
  const chunks: Buffer[] = [];
  let bytes = 0;
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    if (!meta || meta.expectedSize !== wireBytes || meta.filename ||
        (meta.disposition && meta.disposition !== 'inline') ||
        (meta.contentType && meta.contentType !== 'text/plain')) {
      return { ...identity, result: { disposition: 'quarantine', reason: 'missing-metadata' } };
    }
    for await (const chunk of content as AsyncIterable<unknown>) {
      signal.throwIfAborted();
      if (!Buffer.isBuffer(chunk)) return { ...identity, result: { disposition: 'quarantine', reason: 'invalid-text' } };
      bytes += chunk.byteLength;
      const rejection = checkInboundMailBudget('decodedTextBytes', bytes);
      if (rejection) return { ...identity, result: rejection };
      chunks.push(chunk);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', stop);
    content.destroy();
  }

  let text: string;
  try {
    text = new TextDecoder(meta?.charset ?? 'utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } catch {
    return { ...identity, result: { disposition: 'quarantine', reason: 'invalid-text' } };
  }
  const result = classifyInboundMail(flags, measured(Buffer.byteLength(text, 'utf8')));
  if (result.disposition !== 'accept') return { ...identity, result };
  const source = message.envelope;
  const envelope = source && { from: source.from, subject: source.subject, messageId: source.messageId, inReplyTo: source.inReplyTo };
  return { ...identity, result, text, envelope, headers: message.headers };
}

async function readBatch(client: Client, cursor: Cursor, signal: AbortSignal): Promise<Batch> {
  await client.connect();
  signal.throwIfAborted();
  const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
  signal.throwIfAborted();
  const uidValidity = String(mailbox.uidValidity);
  if (!validEpoch(uidValidity) || !inUidRange(mailbox.uidNext, 1)) throw new Error('Invalid mailbox epoch');
  if (cursor.uidValidity && cursor.uidValidity !== uidValidity) return { status: 'resync', uidValidity };

  if (mailbox.uidNext <= cursor.afterUid) throw new Error('Mailbox UIDNEXT moved backward');
  const first = cursor.afterUid + 1;
  const throughUid = Math.min(first + 7, mailbox.uidNext - 1);
  const batch = { status: 'batch', uidValidity, throughUid, messages: [] as Message[] } as const;
  if (first > throughUid) return batch;
  const rows = await client.fetchAll(String(first) + ':' + throughUid, sizeQuery, uidMode);
  signal.throwIfAborted();
  if (rows.length > throughUid - first + 1) throw new Error('Invalid UID window');
  let previous = cursor.afterUid;
  for (const { uid, emailId, size } of rows.sort((a, b) => a.uid - b.uid)) {
    if (!inUidRange(uid, previous + 1) || uid > throughUid || !validProviderId(emailId)) throw new Error('Invalid message identity');
    previous = uid;
    const messageSignal = AbortSignal.any([signal, AbortSignal.timeout(INBOUND_MAIL_BUDGETS.processingMs)]);
    const message = await abortable(messageSignal, () => readMessage(client, uid, emailId, size ?? 0, messageSignal));
    signal.throwIfAborted();
    batch.messages.push(message);
  }
  return batch;
}

/** One bounded poll. Envelope and selected headers remain untrusted mail data. */
export function createGmailImap(
  env: NodeJS.ProcessEnv,
  create: GmailImapFactory = (options) => new ImapFlow(options),
) {
  const auth = readGmailConfig(env);
  return {
    async poll(cursor: Cursor, cancel: AbortSignal): Promise<Batch> {
      if (!inUidRange(cursor.afterUid, 0) ||
          (cursor.uidValidity === undefined ? cursor.afterUid !== 0 : !validEpoch(cursor.uidValidity))) {
        throw new Error('Invalid Gmail inbox cursor');
      }
      const signal = AbortSignal.any([cancel, AbortSignal.timeout(30_000)]);
      let client: Client | undefined;
      try {
        signal.throwIfAborted();
        const configured = create({
          host: 'imap.gmail.com', port: 993, secure: true,
          tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'imap.gmail.com' },
          auth, logger: false, logRaw: false, emitLogs: false,
          disableAutoIdle: true, disableCompression: true,
          maxLineLength: 262_144,
          maxLiteralSize: INBOUND_MAIL_BUDGETS.wireBytes,
          maxResponseSize: INBOUND_MAIL_BUDGETS.wireBytes + 262_144,
          connectionTimeout: 10_000, greetingTimeout: 5_000, socketTimeout: 5_000,
        });
        client = configured;
        client.on('error', () => { /* Suppress raw client diagnostics. */ });
        return await abortable(signal, () => readBatch(configured, cursor, signal));
      } catch {
        throw new Error('Gmail inbox retrieval failed');
      } finally {
        try { client?.close(); } catch { /* Close errors can contain transport details. */ }
      }
    },
  };
}
