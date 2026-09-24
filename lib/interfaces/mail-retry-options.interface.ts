import type { Duration } from './duration.interface.js';

/** The retry vocabulary shared by the family's packages (`attempts`, `backoff`, `retryIf`). */
export interface MailRetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** Waits between attempts, or a function of the attempt that just failed (1-based). */
  backoff?: MailBackoffOptions | ((attempt: number, error: unknown) => Duration);
  /**
   * Asked about every failure the mailer would retry (errors that aren't `permanent`),
   * so it can only narrow the default. Return `false` to stop retrying.
   */
  retryIf?: (error: unknown, attempt: number) => boolean;
}

export interface MailBackoffOptions {
  /** Wait before the first retry. Default `'1s'`. */
  delay?: Duration;
  /** Growth per retry; 1 = constant. Default 2. */
  factor?: number;
  /** Cap for a single wait. Default `'30s'`. */
  maxDelay?: Duration;
  /** Default `'full'`. */
  jitter?: 'full' | 'equal' | 'none';
}
