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

/** The fields every message has, whether passed to `send()` or returned from a mail class. */
export interface MailContent {
  subject: string;
  /**
   * The HTML body: `SafeHtml` from the `html` template, or a string, taken as trusted
   * HTML (the output of React Email, MJML or another template engine).
   */
  html?: string | SafeHtml;
  /** The plain-text body. Derived from `html` when omitted. */
  text?: string;
  attachments?: MailAttachmentInput[];
  /** Custom headers, such as `List-Unsubscribe` or `X-Entity-Ref-ID`. */
  headers?: Record<string, string>;
  /** Overrides the module's `from`. */
  from?: MailAddressInput;
  /** Overrides the module's `replyTo`. */
  replyTo?: MailAddressInput | MailAddressInput[];
}

/** Recipients, for `send()` with a message and with a mail class. */
export interface MailRecipients {
  to?: MailAddressInput | MailAddressInput[];
  cc?: MailAddressInput | MailAddressInput[];
  bcc?: MailAddressInput | MailAddressInput[];
}
