import { toMs } from './duration.util.js';
import type { Duration } from '../interfaces/duration.interface.js';
import type { MailBackoffOptions, MailRetryOptions } from '../interfaces/mail-retry-options.interface.js';

export type RetryInput = number | false | MailRetryOptions | undefined;

type BackoffFn = (attempt: number, error: unknown) => Duration;

export interface ResolvedRetry {
  attempts: number;
  backoff: { delay: number; factor: number; maxDelay: number; jitter: 'full' | 'equal' | 'none' } | BackoffFn;
  retryIf?: (error: unknown, attempt: number) => boolean;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF = { delay: 1_000, factor: 2, maxDelay: 30_000, jitter: 'full' } as const;
const JITTERS: readonly unknown[] = ['full', 'equal', 'none'];
/** The longest delay `setTimeout` supports (about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Resolves a `retry` option. `where` names it in errors: the module's option fails at
 * startup, a per-send override when that send is made.
 */
export function resolveRetry(input: RetryInput, where: string): ResolvedRetry {
  const options: MailRetryOptions =
    input === false ? { attempts: 1 } : typeof input === 'number' ? { attempts: input } : (input ?? {});
  if (typeof options !== 'object' || options === null) {
    throw new TypeError(`${where}: retry must be a number, false, or { attempts, backoff, retryIf }`);
  }

  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError(
      `${where}: retry.attempts must be a whole number of at least 1 (got ${attempts}). ` +
        'Use `retry: false` for a single attempt.',
    );
  }

  const { backoff, retryIf } = options;
  if (retryIf !== undefined && typeof retryIf !== 'function') {
    throw new TypeError(`${where}: retry.retryIf must be a function`);
  }
  if (typeof backoff === 'function') {
    return { attempts, backoff, retryIf };
  }

  if (backoff !== undefined && (backoff === null || typeof backoff !== 'object')) {
    throw new TypeError(`${where}: retry.backoff must be { delay, factor, maxDelay, jitter } or a function`);
  }

  const b: MailBackoffOptions = backoff ?? {};
  const factor = b.factor ?? DEFAULT_BACKOFF.factor;
  if (!(factor >= 1)) {
    throw new TypeError(`${where}: retry.backoff.factor must be at least 1 (got ${factor})`);
  }

  const jitter = b.jitter ?? DEFAULT_BACKOFF.jitter;
  if (!JITTERS.includes(jitter)) {
    throw new TypeError(`${where}: retry.backoff.jitter must be "full", "equal" or "none"`);
  }

  return {
    attempts,
    retryIf,
    backoff: {
      delay: durationOption(b.delay ?? DEFAULT_BACKOFF.delay, `${where}: retry.backoff.delay`),
      factor,
      maxDelay: durationOption(b.maxDelay ?? DEFAULT_BACKOFF.maxDelay, `${where}: retry.backoff.maxDelay`),
      jitter,
    },
  };
}

/** The wait after attempt `attempt` (1-based) failed: `min(maxDelay, delay * factor^(attempt-1))`, jittered. */
export function backoffDelay(retry: ResolvedRetry, attempt: number, error: unknown, random = Math.random): number {
  if (typeof retry.backoff === 'function') {
    return durationOption(retry.backoff(attempt, error), 'retry.backoff()');
  }

  const { delay, factor, maxDelay, jitter } = retry.backoff;
  const ceiling = Math.min(maxDelay, delay * factor ** (attempt - 1));

  switch (jitter) {
    case 'none':
      return Math.floor(ceiling);
    case 'equal':
      return Math.floor(ceiling / 2 + (random() * ceiling) / 2);
    default:
      return Math.floor(random() * ceiling);
  }
}

/** `toMs()` with the option's name in the error. */
export function durationOption(value: Duration, option: string): number {
  let ms: number;
  try {
    ms = toMs(value);
  } catch (error) {
    throw new TypeError(`${option}: ${(error as Error).message}`);
  }

  if (ms > MAX_TIMER_MS) {
    throw new TypeError(`${option}: ${JSON.stringify(value)} is longer than a timer can wait`);
  }
  return ms;
}

/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason);
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
