import type { MailAddress, MailAttachment } from '../interfaces/mail-message.interface.js';
import type { Type } from '@nestjs/common';
import { isInternationalized } from './address.util.js';
import { buildMime } from './mime.util.js';

/** Only the mailer's validation creates messages: a hand-built one could carry a line break into a header. */
const CREATE = Symbol('MailMessage.create');

/** @internal What `MailMessage` is built from, after validation. */
export interface MailMessageInit {
  messageId: string;
  date: Date;
  from: MailAddress;
  replyTo: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  html?: string;
  text?: string;
  attachments: MailAttachment[];
  headers: Record<string, string>;
  mail?: Type;
  locale?: string;
}

/**
 * A validated message, ready for a transport: every address parsed, attachments read,
 * `text` derived from `html` when it was left out, `Message-ID` and `Date` set. What a
 * transport receives, and what `Mailer.render()` returns. Immutable.
 */
export class MailMessage {
  /** `<id@domain>`, as in the `Message-ID` header. Derived from `idempotencyKey` when one was given. */
  readonly messageId: string;
  readonly date: Date;
  readonly from: MailAddress;
  readonly replyTo: readonly MailAddress[];
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  /** Envelope recipients only: never written to a header. */
  readonly bcc: readonly MailAddress[];
  readonly subject: string;
  readonly html?: string;
  readonly text?: string;
  readonly attachments: readonly MailAttachment[];
  /** Custom headers, as given (without the ones the message sets itself). */
  readonly headers: Readonly<Record<string, string>>;
  /** The mail class that rendered the message, when it came from one. */
  readonly mail?: Type;
  /** The locale the mail class rendered in. */
  readonly locale?: string;
  #mime?: Buffer;

  /** @internal Built by the mailer, which validates every field first. */
  constructor(init: MailMessageInit, token: typeof CREATE) {
    if (token !== CREATE) {
      throw new TypeError('MailMessage is created by the mailer; use Mailer#render() to build one');
    }

    this.messageId = init.messageId;
    this.date = init.date;
    this.from = Object.freeze({ ...init.from });
    this.replyTo = freezeList(init.replyTo);
    this.to = freezeList(init.to);
    this.cc = freezeList(init.cc);
    this.bcc = freezeList(init.bcc);
    this.subject = init.subject;
    if (init.html !== undefined) {
      this.html = init.html;
    }
    if (init.text !== undefined) {
      this.text = init.text;
    }
    this.attachments = Object.freeze(init.attachments.map((a) => Object.freeze({ ...a })));
    this.headers = Object.freeze({ ...init.headers });
    if (init.mail) {
      this.mail = init.mail;
    }
    if (init.locale !== undefined) {
      this.locale = init.locale;
    }

    Object.freeze(this);
  }

  /** The SMTP envelope: the sender, and every recipient (to, cc and bcc) once. */
  get envelope(): { from: string; to: string[] } {
    const to: string[] = [];
    for (const { address } of [...this.to, ...this.cc, ...this.bcc]) {
      if (!to.some((seen) => seen.toLowerCase() === address.toLowerCase())) {
        to.push(address);
      }
    }
    return { from: this.from.address, to };
  }

  /** True when an address has a non-ASCII local part, so SMTP needs SMTPUTF8. */
  get internationalized(): boolean {
    return [this.from, ...this.replyTo, ...this.to, ...this.cc, ...this.bcc].some((a) =>
      isInternationalized(a.address),
    );
  }

  /**
   * The message in RFC 5322 / MIME form (an `.eml` file), with CRLF line endings.
   * Without `Bcc`. Built once; each call returns a copy.
   */
  toMime(): Buffer {
    // Private fields aren't properties, so freezing the object doesn't stop this cache.
    return Buffer.from((this.#mime ??= buildMime(this)));
  }
}

/** @internal */
export function newMailMessage(init: MailMessageInit): MailMessage {
  return new MailMessage(init, CREATE);
}

function freezeList(list: MailAddress[]): readonly MailAddress[] {
  return Object.freeze(list.map((a) => Object.freeze({ ...a })));
}
