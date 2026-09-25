import type { MailContent, MailRecipients, MailTemplateContent } from './mail-message.interface.js';
import type { MailRetryOptions } from './mail-retry-options.interface.js';

/** How one `send()` is delivered. */
export interface MailDeliveryOptions {
  /** Overrides the module's `retry` for this send. */
  retry?: number | false | MailRetryOptions;
  /** Aborts the send, including a wait between attempts. It rejects with `signal.reason`. */
  signal?: AbortSignal;
  /**
   * Identifies this mail across redeliveries, e.g. the outbox message id. The message's
   * `Message-ID` is derived from it, so over SMTP a redelivery carries the same one
   * (which Gmail, among others, uses to drop the duplicate), and a provider with
   * idempotency keys (Resend) gets it as one and refuses the duplicate. The other HTTP
   * providers assign their own `Message-ID` and can deliver a redelivery twice. One key
   * per mail: two different mails with the same key are treated as the same one.
   */
  idempotencyKey?: string;
}

/** `mailer.send({ ... })`: a message written inline, as HTML or from a template. */
export type MailSendOptions = MailRenderOptions & MailDeliveryOptions;

/** `mailer.render({ ... })`: the same, without delivery options. Recipients are optional. */
export type MailRenderOptions = (MailContent | MailTemplateContent) &
  MailRecipients & {
    /** The locale the template is rendered in, and recorded on the message. */
    locale?: string;
  };

/** What `send()` resolves to. */
export interface MailSendResult {
  /**
   * The `Message-ID` the message was built with, `<id@domain>`. It is the one on the
   * wire over SMTP; Resend, Postmark, SendGrid and SES assign their own.
   */
  messageId: string;
  /** The provider's id for the message (Resend `id`, Postmark `MessageID`, SES `MessageId`), when it has one. */
  providerMessageId?: string;
  /** The envelope recipients the transport accepted. */
  accepted: string[];
  /** The final server reply (SMTP), e.g. `250 2.0.0 Ok: queued as 4Fz1`. */
  response?: string;
  /** Attempts it took, 1 when the first one succeeded. */
  attempts: number;
}
