import { truncate } from '../utils/truncate.util.js';
import { MailError } from './mail.error.js';

/**
 * An HTTP provider (Resend, Postmark, SendGrid, SES) refused the request. `code` is the
 * HTTP status. Permanent for 4xx other than 408, 409 (a concurrent request with the same
 * idempotency key) and 429; transient for those and 5xx.
 */
export class MailProviderError extends MailError {
  declare readonly code: number;
  /** `resend`, `postmark`, `sendgrid` or `ses`. */
  readonly provider: string;
  /** The provider's own error name or number, e.g. `validation_error`, `300`, `MessageRejected`. */
  declare readonly providerCode?: string;

  constructor(init: {
    provider: string;
    status: number;
    providerCode?: string;
    detail?: string;
    permanent?: boolean;
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
  }
}

function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
}
