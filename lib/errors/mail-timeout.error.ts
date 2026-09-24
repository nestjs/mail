import { MailError } from './mail.error.js';

/** A phase of the exchange outlived its timeout. Transient. */
export class MailTimeoutError extends MailError {
  /** `connect`, `greeting`, `tls`, `command`, `data` (SMTP), or `request` (HTTP providers). */
  readonly phase: string;
  readonly timeoutMs: number;

  constructor(phase: string, timeoutMs: number, detail = '') {
    super(`Mail ${phase} timed out after ${timeoutMs}ms${detail ? ` (${detail})` : ''}`, {
      permanent: false,
    });
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}
