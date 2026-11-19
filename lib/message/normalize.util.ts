import type { Type } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { MailMessageError } from '../errors/mail-message.error.js';
import { parseAddress, parseAddressList } from './address.util.js';
import type {
  MailAddress,
  MailAddressInput,
  MailAttachment,
  MailAttachmentInput,
  MailCalendar,
  MailCalendarInput,
  MailCalendarMethod,
  MailContent,
  MailRecipients,
} from '../interfaces/mail-message.interface.js';
import { normalizeNewlines } from './encoding.util.js';
import { checkHeaderName, checkHeaderValue, mergeHeaders } from './headers.util.js';
import { isSafeHtml } from './html.util.js';
import { type MailMessage, newMailMessage } from './mail-message.js';
import { htmlToText } from './text.util.js';

/** What the module adds to every message. */
export interface MailDefaults {
  from?: MailAddressInput;
  replyTo?: MailAddressInput | MailAddressInput[];
  headers?: Record<string, string>;
}

/** Headers the message builds itself, and the option to use instead. */
const RESERVED: Record<string, string> = {
  from: 'the `from` option',
  to: 'the `to` option',
  cc: 'the `cc` option',
  bcc: 'the `bcc` option',
  'reply-to': 'the `replyTo` option',
  subject: 'the `subject` field',
  date: 'nothing: the mailer sets it',
  'message-id': 'the `idempotencyKey` option (the Message-ID is derived from it)',
  sender: 'the `from` option',
  'return-path': 'nothing: the receiving server sets it from the envelope',
  'mime-version': 'nothing: the mailer sets it',
  'content-type': 'nothing: the mailer sets it',
  'content-transfer-encoding': 'nothing: the mailer sets it',
  'content-disposition': 'nothing: the mailer sets it',
  'content-id': 'the `cid` of an attachment',
  'dkim-signature': 'the `dkim` option of SmtpTransport',
};

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.ics': 'text/calendar',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** The iTIP methods (RFC 5546 §1.4). */
const CALENDAR_METHODS: readonly MailCalendarMethod[] = [
  'PUBLISH',
  'REQUEST',
  'REPLY',
  'ADD',
  'CANCEL',
  'REFRESH',
  'COUNTER',
  'DECLINECOUNTER',
];

const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const CID = /^[A-Za-z0-9._\-@]{1,200}$/;

export interface NormalizeInput extends Omit<MailContent, 'template' | 'context'>, MailRecipients {
  mail?: Type;
  locale?: string;
  /** The template the HTML was rendered from. */
  template?: string;
  idempotencyKey?: string;
}

/**
 * Validates everything and reads the attachments. Throws `MailMessageError` naming the
 * field; nothing is sent until the whole message is valid.
 */
export async function createMailMessage(
  input: NormalizeInput,
  defaults: MailDefaults,
  now = new Date(),
): Promise<MailMessage> {
  const fromInput = input.from ?? defaults.from;
  if (fromInput === undefined) {
    throw new MailMessageError('from', 'is missing: set it on the message, or `from` in MailModule.forRoot()');
  }

  const from = parseAddress(fromInput, 'from');
  const to = parseAddressList(input.to, 'to');
  const cc = parseAddressList(input.cc, 'cc');
  const bcc = parseAddressList(input.bcc, 'bcc');
  const replyTo = parseAddressList(input.replyTo ?? defaults.replyTo, 'replyTo');

  if (typeof input.subject !== 'string') {
    throw new MailMessageError('subject', 'must be a string');
  }
  const subject = checkHeaderValue(input.subject, 'subject');

  const html = input.html === undefined ? undefined : isSafeHtml(input.html) ? input.html.value : input.html;
  if (html !== undefined && typeof html !== 'string') {
    throw new MailMessageError('html', 'must be a string or the result of the html template');
  }
  if (input.text !== undefined && typeof input.text !== 'string') {
    throw new MailMessageError('text', 'must be a string');
  }
  const text = input.text ?? (html !== undefined ? htmlToText(html) : undefined);
  if (html === undefined && text === undefined) {
    throw new MailMessageError('html', 'or `text` is required: a mail needs a body');
  }

  const headers = checkHeaders(mergeHeaders(defaults.headers, input.headers));
  const attachments = await Promise.all(
    (input.attachments ?? []).map((attachment, i) => readAttachment(attachment, `attachments[${i}]`)),
  );
  const cids = attachments.flatMap((a) => (a.cid ? [a.cid] : []));
  const duplicate = cids.find((cid, i) => cids.indexOf(cid) !== i);
  if (duplicate) {
    throw new MailMessageError('attachments', `use the cid "${duplicate}" twice`);
  }

  const calendar = input.calendar === undefined ? undefined : readCalendar(input.calendar);

  if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey)) {
    throw new MailMessageError('idempotencyKey', 'must be a non-empty string');
  }

  return newMailMessage({
    messageId: messageId(from, input.idempotencyKey),
    date: now,
    from,
    replyTo,
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    attachments,
    ...(calendar && { calendar }),
    headers,
    mail: input.mail,
    locale: input.locale,
    template: input.template,
  });
}

/** Throws unless the message has somebody to go to. Checked when sending, not when rendering a preview. */
export function assertRecipients(message: MailMessage): void {
  if (!message.to.length && !message.cc.length && !message.bcc.length) {
    throw new MailMessageError('to', 'is missing: a mail needs at least one recipient (to, cc or bcc)');
  }
}

/**
 * `<random@sender-domain>`, or with an idempotency key a stable id derived from it: a
 * redelivery of the same mail carries the same Message-ID, which Gmail, among others,
 * uses to drop the duplicate.
 */
function messageId(from: MailAddress, idempotencyKey: string | undefined): string {
  const domain = from.address.slice(from.address.lastIndexOf('@') + 1);
  const id = idempotencyKey
    ? createHash('sha256').update(`nestjs-mail:${idempotencyKey}`).digest('base64url').slice(0, 32)
    : randomUUID();
  return `<${id}@${domain}>`;
}

export function checkHeaders(headers: Record<string, string>): Record<string, string> {
  const seen = new Set<string>();
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    const field = `headers.${name}`;
    checkHeaderName(name, field);
    const lower = name.toLowerCase();
    if (RESERVED[lower]) {
      throw new MailMessageError(field, `can't be set as a header: use ${RESERVED[lower]}`);
    }
    if (seen.has(lower)) {
      throw new MailMessageError(field, 'is set twice (header names are case-insensitive)');
    }
    seen.add(lower);
    out[name] = checkHeaderValue(value, field);
  }

  return out;
}

async function readAttachment(input: MailAttachmentInput, field: string): Promise<MailAttachment> {
  if (!input || typeof input !== 'object') {
    throw new MailMessageError(field, 'must be an object');
  }

  const { filename, cid } = input;
  if ((input.content === undefined) === (input.path === undefined)) {
    throw new MailMessageError(field, 'needs exactly one of `content` and `path`');
  }

  const name = filename ?? (input.path !== undefined ? basename(input.path) : undefined);
  if (name !== undefined) {
    checkFilename(name, `${field}.filename`);
  }

  if (cid !== undefined && (typeof cid !== 'string' || !CID.test(cid))) {
    throw new MailMessageError(`${field}.cid`, 'may only contain letters, digits and ".-_@"');
  }
  if (name === undefined && cid === undefined) {
    throw new MailMessageError(`${field}.filename`, 'is required for an attachment (inline images may omit it)');
  }

  const contentType = (input.contentType ?? CONTENT_TYPES[extname(name ?? '').toLowerCase()] ?? 'application/octet-stream')
    .trim()
    .toLowerCase();
  if (!CONTENT_TYPE.test(contentType)) {
    throw new MailMessageError(`${field}.contentType`, 'must be a MIME type such as "application/pdf", without parameters');
  }

  return {
    ...(name !== undefined && { filename: name }),
    content: await readContent(input, field),
    contentType,
    ...(cid !== undefined && { cid }),
    disposition: cid !== undefined ? 'inline' : 'attachment',
  };
}

function checkFilename(name: unknown, field: string): string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new MailMessageError(field, 'must be a non-empty string');
  }
  checkHeaderValue(name, field);
  if (name.length > 255) {
    throw new MailMessageError(field, 'is longer than 255 characters');
  }
  return name;
}

/**
 * Validates a calendar invitation. The method and the content's `METHOD` property must
 * agree (RFC 6047 §2.4): a client that sees them differ drops the invitation without
 * telling the sender.
 */
function readCalendar(input: MailCalendarInput): MailCalendar {
  if (!input || typeof input !== 'object') {
    throw new MailMessageError('calendar', 'must be an object such as { content, method? }');
  }

  const content = calendarText(input.content);
  const declared = calendarMethod(content);
  let method: MailCalendarMethod | undefined;

  if (input.method !== undefined) {
    const given = typeof input.method === 'string' ? input.method.trim().toUpperCase() : undefined;
    if (!isCalendarMethod(given)) {
      throw new MailMessageError('calendar.method', `must be one of ${CALENDAR_METHODS.join(', ')}`);
    }
    if (declared !== undefined && declared !== given) {
      throw new MailMessageError(
        'calendar.method',
        `is ${given}, but the content says METHOD:${declared}: they must agree, or clients drop the invitation`,
      );
    }
    method = given;
  } else if (declared !== undefined) {
    if (!isCalendarMethod(declared)) {
      throw new MailMessageError(
        'calendar.content',
        `has METHOD:${declared}, which is not one of ${CALENDAR_METHODS.join(', ')}`,
      );
    }
    method = declared;
  }

  const filename = input.filename === undefined ? 'invite.ics' : checkFilename(input.filename, 'calendar.filename');
  return { content, ...(method && { method }), filename };
}

/** The iCalendar object as text with CRLF line breaks, which RFC 5545 requires. */
function calendarText(content: unknown): string {
  let text: string;
  if (typeof content === 'string') {
    // A byte order mark, as TextDecoder drops it from bytes
    text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  } else if (content instanceof Uint8Array) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw new MailMessageError('calendar.content', 'is not valid UTF-8');
    }
  } else {
    throw new MailMessageError('calendar.content', 'must be a string or a Uint8Array (the iCalendar object)');
  }
  return normalizeNewlines(text);
}

/**
 * The `METHOD` property of the `VCALENDAR` (uppercase), or `undefined` when it has none.
 * Lines are unfolded first (RFC 5545 §3.1); properties of nested components are skipped.
 */
function calendarMethod(content: string): string | undefined {
  const lines = content.replace(/\r\n[ \t]/g, '').split('\r\n');
  const components: string[] = [];
  let calendar = false;
  let method: string | undefined;

  for (const line of lines) {
    const component = /^(BEGIN|END):(.*)$/i.exec(line.trimEnd());
    if (component) {
      const name = component[2].trim().toUpperCase();
      if (component[1].toUpperCase() === 'BEGIN') {
        calendar ||= name === 'VCALENDAR';
        components.push(name);
      } else {
        components.pop();
      }
      continue;
    }

    const property = /^METHOD(?:;[^:]*)?:(.*)$/i.exec(line);
    if (property && components.length === 1 && components[0] === 'VCALENDAR') {
      if (method !== undefined) {
        throw new MailMessageError('calendar.content', 'has more than one METHOD property');
      }
      method = property[1].trim().toUpperCase();
    }
  }

  if (!calendar) {
    throw new MailMessageError('calendar.content', 'is not an iCalendar object: it has no BEGIN:VCALENDAR');
  }
  return method;
}

function isCalendarMethod(method: string | undefined): method is MailCalendarMethod {
  return CALENDAR_METHODS.includes(method as MailCalendarMethod);
}

async function readContent(input: MailAttachmentInput, field: string): Promise<Buffer> {
  const { content, path } = input;
  if (path !== undefined) {
    if (typeof path !== 'string' || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
      throw new MailMessageError(`${field}.path`, 'must be a local file path (URLs are not fetched)');
    }
    return readFile(path);
  }

  if (typeof content === 'string') {
    return Buffer.from(content, 'utf8');
  }
  if (content instanceof Uint8Array) {
    return Buffer.from(content);
  }
  if (content instanceof Readable || content instanceof ReadableStream) {
    const stream = content instanceof ReadableStream ? Readable.fromWeb(content as never) : content;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new MailMessageError(`${field}.content`, 'must be a string, a Buffer, or a readable stream');
}
