import { truncate } from '../utils/truncate.util.js';
import { MailError } from './mail.error.js';

/**
 * An HTTP provider (Resend, Postmark, SendGrid, SES) refused the request. `code` is the
 * HTTP status. Permanent for 4xx other than 408, 409 (a concurrent request with the same
 * idempotency key) and 429; transient for those and 5xx. A `Retry-After` header on the
 * response is kept as `retryAfterMs`, and the mailer waits at least that long before
 * retrying.
 */
export class MailProviderError extends MailError {
  declare readonly code: number;
  /** `resend`, `postmark`, `sendgrid` or `ses`. */
  readonly provider: string;
  /** The provider's own error name or number, e.g. `validation_error`, `300`, `MessageRejected`. */
  declare readonly providerCode?: string;
  /**
   * How long the provider asked to wait before trying again, from a `Retry-After` header
   * (seconds or an HTTP date); left out when there was none or it was malformed.
   */
  declare readonly retryAfterMs?: number;

  constructor(init: {
    provider: string;
    status: number;
    providerCode?: string;
    detail?: string;
    permanent?: boolean;
    retryAfterMs?: number;
  }) {
    const { provider, status, providerCode, detail } = init;
    super(
      `${provider} refused the message with ${status}${providerCode ? ` ${providerCode}` : ''}` +
        (detail ? `: ${truncate(detail)}` : ''),
      { permanent: init.permanent ?? isPermanentStatus(status), code: status },
    );

    this.provider = provider;
    if (providerCode !== undefined) {
      (this as { providerCode?: string }).providerCode = providerCode;
    }
    if (init.retryAfterMs !== undefined) {
      (this as { retryAfterMs?: number }).retryAfterMs = init.retryAfterMs;
    }
  }
}

function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
}
