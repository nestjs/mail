import { MailError } from './mail.error.js';

/**
 * The message is invalid: a malformed address, a header with a line break, an
 * attachment without a filename, no recipients. Thrown before anything is sent, never
 * retried. `status` is 400, so other packages (resilience) treat it as the caller's
 * mistake without importing it.
 */
export class MailMessageError extends MailError {
  readonly status = 400;
  /** The offending field, e.g. `to[1]`, `headers.X-Campaign`, `attachments[0].filename`. */
  readonly field: string;

  constructor(field: string, problem: string) {
    super(`Invalid mail: ${field} ${problem}`, { permanent: true });
    this.field = field;
  }
}
