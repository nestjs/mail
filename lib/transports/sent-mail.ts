import type { Type } from '@nestjs/common';
import type { MailAddress, MailAttachment } from '../interfaces/mail-message.interface.js';
import type { MailMessage } from '../message/mail-message.js';
import { extractLinks } from '../message/text.util.js';

/** A mail the in-memory transport received, with helpers for tests. */
export class SentMail {
  constructor(
    /** The message as the transport got it. */
    readonly message: MailMessage,
    readonly sentAt: Date,
  ) {}

  get messageId(): string {
    return this.message.messageId;
  }
  get from(): MailAddress {
    return this.message.from;
  }
  get to(): readonly MailAddress[] {
    return this.message.to;
  }
  get cc(): readonly MailAddress[] {
    return this.message.cc;
  }
  get bcc(): readonly MailAddress[] {
    return this.message.bcc;
  }
  get subject(): string {
    return this.message.subject;
  }
  get html(): string | undefined {
    return this.message.html;
  }
  get text(): string | undefined {
    return this.message.text;
  }
  get attachments(): readonly MailAttachment[] {
    return this.message.attachments;
  }
  get headers(): Readonly<Record<string, string>> {
    return this.message.headers;
  }
  get mail(): Type | undefined {
    return this.message.mail;
  }
  get locale(): string | undefined {
    return this.message.locale;
  }
  /** The message as MIME (the `.eml` source), for assertions on headers and encoding. */
  get raw(): string {
    return this.message.toMime().toString('utf8');
  }

  /**
   * Every link in the mail, in order: `href`s from the HTML (with `&amp;` decoded), then
   * URLs from the text part that the HTML didn't have.
   */
  get links(): string[] {
    return extractLinks(this.message.html, this.message.text);
  }

  /**
   * The first link containing `match` (a string) or matching it (a RegExp), as a `URL`,
   * so a test can read its token: `mail.link('/reset-password').searchParams.get('token')`.
   * Throws, listing the links there are, when none matches.
   */
  link(match?: string | RegExp): URL {
    const links = this.links;
    const found = links.find((link) =>
      match === undefined ? true : typeof match === 'string' ? link.includes(match) : match.test(link),
    );

    if (found === undefined) {
      throw new Error(
        `No link${match === undefined ? '' : ` matching ${String(match)}`} in the mail "${this.subject}". ` +
          `Links: ${links.length ? links.join(', ') : 'none'}`,
      );
    }
    if (!URL.canParse(found)) {
      throw new Error(`The link "${found}" in the mail "${this.subject}" is not absolute: links in mail need a scheme and host`);
    }

    return new URL(found);
  }

  /** The attachment with this filename; throws when there is none. */
  attachment(filename: string): MailAttachment {
    const found = this.attachments.find((a) => a.filename === filename);
    if (!found) {
      const names = this.attachments.map((a) => a.filename ?? `cid:${a.cid}`);
      throw new Error(`No attachment "${filename}" in the mail "${this.subject}". Attachments: ${names.join(', ') || 'none'}`);
    }
    return found;
  }
}
