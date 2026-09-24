/**
 * Base class of every error this package throws. `permanent` says whether sending the
 * same message again can succeed: `false` for timeouts, dropped connections, 4xx SMTP
 * replies, 429 and 5xx provider responses; `true` for 5xx SMTP replies, other 4xx
 * provider responses and messages that fail validation. The mailer retries only errors
 * that aren't permanent; an outbox handler dead-letters the ones that are.
 *
 * Messages never contain credentials. They may contain addresses and the server's own
 * reply text, which is what an operator needs to fix a rejection.
 */
export class MailError extends Error {
  /** Retrying the same message can't succeed. */
  readonly permanent: boolean;
  /** The SMTP reply code (e.g. `550`) or the provider's HTTP status (e.g. `422`), when there was one. */
  declare readonly code?: number;

  constructor(message: string, init: { permanent: boolean; code?: number; cause?: unknown }) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.permanent = init.permanent;
    if (init.code !== undefined) {
      (this as { code?: number }).code = init.code;
    }
  }
}
