import type { Readable } from 'node:stream';
import type { SafeHtml } from '../message/html.util.js';

/** An address as the app passes it: `'ada@example.com'`, `'Ada Lovelace <ada@example.com>'` or an object. */
export type MailAddressInput = string | { name?: string; address: string };

/** A parsed, validated address. `address` has its domain in ASCII (IDNA); `name` is the display name. */
export interface MailAddress {
  readonly name?: string;
  readonly address: string;
}

/** An attachment, read into memory and validated. */
export interface MailAttachment {
  readonly filename?: string;
  readonly content: Buffer;
  readonly contentType: string;
  /** Set for inline parts, referenced from the HTML as `<img src="cid:…">`. */
  readonly cid?: string;
  readonly disposition: 'attachment' | 'inline';
}

/** An attachment as the app passes it. Give `content` or `path`, not both. */
export interface MailAttachmentInput {
  /** The name the recipient sees. Required for attachments; optional for inline images. */
  filename?: string;
  /** The bytes: a string (UTF-8), a Buffer, or a Node or web stream (read fully before sending). */
  content?: string | Uint8Array | Readable | ReadableStream<Uint8Array>;
  /**
   * A local file, read when the mail is sent. Never pass a path built from user input:
   * the file is attached whatever it is.
   */
  path?: string;
  /** Defaults from the filename's extension, else `application/octet-stream`. */
  contentType?: string;
  /**
   * Makes the attachment an inline part that the HTML references as `<img src="cid:logo">`.
   * Letters, digits and `.-_@`.
   */
  cid?: string;
}

/** An iTIP method (RFC 5546): what a calendar invitation asks of its recipient. */
export type MailCalendarMethod =
  | 'PUBLISH'
  | 'REQUEST'
  | 'REPLY'
  | 'ADD'
  | 'CANCEL'
  | 'REFRESH'
  | 'COUNTER'
  | 'DECLINECOUNTER';

/**
 * A calendar invitation as the app passes it: an iCalendar object (RFC 5545) the app built
 * itself, with `ical-generator`, `ics` or a template. It is sent as a `text/calendar` part
 * next to the text and HTML bodies, which is where mail clients look for an invitation, and
 * again as an attached `.ics` file for clients that only read attachments.
 *
 * To update or cancel an event a calendar already holds, send the same `UID` with a higher
 * `SEQUENCE` (and `METHOD:CANCEL` to cancel it).
 */
export interface MailCalendarInput {
  /** The iCalendar object, as text or UTF-8 bytes. It must contain a `BEGIN:VCALENDAR`. */
  content: string | Uint8Array;
  /**
   * The iTIP method, e.g. `REQUEST` for an invitation. Defaults to the `METHOD` in
   * `content`; when `content` has one, the two must agree, or clients drop the invitation.
   */
  method?: MailCalendarMethod;
  /** The name of the attached copy. Defaults to `invite.ics`. */
  filename?: string;
}

/** A calendar invitation, validated. */
export interface MailCalendar {
  /** The iCalendar object, with CRLF line breaks. */
  readonly content: string;
  /** The iTIP method, uppercase, from the option or from `content`'s `METHOD`. */
  readonly method?: MailCalendarMethod;
  /** The name of the attached copy. */
  readonly filename: string;
}

/**
 * A message written as HTML (or text), whether passed to `send()` or returned from a mail
 * class. `MailTemplateContent` is the same message rendered from a template instead.
 */
export interface MailContent {
  subject: string;
  /**
   * The HTML body: `SafeHtml` from the `html` template, or a string, taken as trusted
   * HTML (the output of React Email, MJML or another template engine).
   */
  html?: string | SafeHtml;
  /** The plain-text body. Derived from `html` when omitted. */
  text?: string;
  /** Not with `html` or `text`: see `MailTemplateContent`. */
  template?: never;
  /** Only with `template`. */
  context?: never;
  attachments?: MailAttachmentInput[];
  /**
   * A calendar invitation (an iCalendar event), shown by mail clients with its
   * accept/decline buttons. Not supported by `ResendTransport` and `PostmarkTransport`.
   */
  calendar?: MailCalendarInput;
  /** Custom headers, such as `List-Unsubscribe` or `X-Entity-Ref-ID`. */
  headers?: Record<string, string>;
  /** Overrides the module's `from`. */
  from?: MailAddressInput;
  /** Overrides the module's `replyTo`. */
  replyTo?: MailAddressInput | MailAddressInput[];
}

/**
 * A message whose body is rendered from a template by the module's `templates` engine,
 * whether passed to `send()` or returned from a mail class.
 */
export interface MailTemplateContent extends Omit<MailContent, 'html' | 'text' | 'template' | 'context'> {
  /**
   * The template's name, such as `order-confirmation`: with `FileTemplateEngine`, the file
   * `order-confirmation.html` (and `order-confirmation.txt` for the text part, if it
   * exists), in the mail's locale when there is one.
   */
  template: string;
  /** The values the template reads, prepared for it: formatted prices, translated strings. */
  context?: object;
  /** The template renders the HTML. */
  html?: never;
  /** The template's `.txt` version renders the text, else it is derived from the HTML. */
  text?: never;
}

/** Recipients, for `send()` with a message and with a mail class. */
export interface MailRecipients {
  to?: MailAddressInput | MailAddressInput[];
  cc?: MailAddressInput | MailAddressInput[];
  bcc?: MailAddressInput | MailAddressInput[];
}
