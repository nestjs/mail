import {
  MailConnectionError,
  MailError,
  MailMessageError,
  MailProviderError,
  MailRecipientsRejectedError,
  MailSmtpError,
  MailTimeoutError,
} from '../lib/index.js';
import { toMs } from '../lib/utils/duration.util.js';
import { parseRetryAfter } from '../lib/utils/retry-after.util.js';
import { backoffDelay, durationOption, resolveRetry, retryDelay, sleep } from '../lib/utils/retry.util.js';
import { truncate } from '../lib/utils/truncate.util.js';

describe('durations', () => {
  it.each([
    [250, 250],
    [0, 0],
    ['500ms', 500],
    ['1.5s', 1_500],
    ['2m', 120_000],
    ['1h', 3_600_000],
    ['1d', 86_400_000],
    ['1w', 604_800_000],
  ] as const)('reads %j as %i ms', (input, ms) => {
    expect(toMs(input)).toBe(ms);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '5', '5 s', '1y', '-1s', ''])('refuses %j', (input) => {
    expect(() => toMs(input as never)).toThrow(TypeError);
  });

  it('names the option, and refuses what a timer cannot wait', () => {
    expect(() => durationOption('soon' as never, 'X `timeout`')).toThrow(/^X `timeout`: Invalid duration "soon"/);
    expect(() => durationOption('4w', 'X `timeout`')).toThrow('X `timeout`: "4w" is longer than a timer can wait');
    expect(durationOption('3w', 'X')).toBe(1_814_400_000);
  });
});

describe('resolveRetry()', () => {
  it('defaults to 3 attempts, 1s doubling to 30s, full jitter', () => {
    expect(resolveRetry(undefined, 'M')).toEqual({
      attempts: 3,
      retryIf: undefined,
      backoff: { delay: 1_000, factor: 2, maxDelay: 30_000, jitter: 'full' },
    });
  });

  it('takes false as one attempt and a number as the attempts', () => {
    expect(resolveRetry(false, 'M').attempts).toBe(1);
    expect(resolveRetry(5, 'M').attempts).toBe(5);
    expect(() => resolveRetry(2.5, 'M')).toThrow(/M: retry\.attempts must be a whole number of at least 1 \(got 2\.5\)/);
  });

  it('keeps a backoff function as it is', () => {
    const backoff = () => 10;
    expect(resolveRetry({ backoff }, 'M').backoff).toBe(backoff);
  });

  it.each([
    [{ retryIf: 'yes' }, /M: retry\.retryIf must be a function/],
    [{ backoff: null }, /M: retry\.backoff must be/],
    [{ backoff: 100 }, /M: retry\.backoff must be/],
    [{ backoff: { factor: 0.5 } }, /M: retry\.backoff\.factor must be at least 1 \(got 0\.5\)/],
    [{ backoff: { jitter: 'some' } }, /M: retry\.backoff\.jitter must be "full", "equal" or "none"/],
    [{ backoff: { maxDelay: '1 hour' } }, /M: retry\.backoff\.maxDelay/],
  ])('refuses %j, naming the option', (retry, message) => {
    expect(() => resolveRetry(retry as never, 'M')).toThrow(message);
  });

  it('refuses a retry option of the wrong type', () => {
    expect(() => resolveRetry('3' as never, 'M')).toThrow(/M: retry must be a number, false, or/);
  });
});

describe('backoffDelay()', () => {
  const retry = (jitter: 'full' | 'equal' | 'none') =>
    resolveRetry({ attempts: 10, backoff: { delay: 100, factor: 3, maxDelay: 2_000, jitter } }, 'M');

  it('grows by the factor per attempt, up to maxDelay', () => {
    const r = retry('none');
    expect([1, 2, 3, 4, 5].map((attempt) => backoffDelay(r, attempt, undefined))).toEqual([100, 300, 900, 2_000, 2_000]);
  });

  it('full jitter waits between 0 and the ceiling, equal jitter between half and the ceiling', () => {
    expect(backoffDelay(retry('full'), 2, undefined, () => 0)).toBe(0);
    expect(backoffDelay(retry('full'), 2, undefined, () => 0.5)).toBe(150);
    expect(backoffDelay(retry('equal'), 2, undefined, () => 0)).toBe(150);
    expect(backoffDelay(retry('equal'), 2, undefined, () => 0.999_999)).toBe(299);
  });

  it('calls a backoff function with the attempt and the error, and checks what it returns', () => {
    const error = new Error('x');
    const backoff = vi.fn((attempt: number, _error: unknown) => `${attempt}s` as const);
    expect(backoffDelay(resolveRetry({ backoff }, 'M'), 2, error)).toBe(2_000);
    expect(backoff).toHaveBeenCalledWith(2, error);

    expect(() => backoffDelay(resolveRetry({ backoff: () => -5 }, 'M'), 1, error)).toThrow(/retry\.backoff\(\): Invalid duration -5/);
  });
});

describe('parseRetryAfter()', () => {
  const now = Date.parse('2026-09-25T10:00:00Z');

  it('reads seconds, and the three HTTP-date forms as GMT', () => {
    expect(parseRetryAfter('7', now)).toBe(7_000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
    expect(parseRetryAfter('Fri, 25 Sep 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Friday, 25-Sep-26 10:01:00 GMT', now)).toBe(60_000);
    expect(parseRetryAfter('Fri Sep 25 10:00:05 2026', now)).toBe(5_000);
  });

  it('reads a date already past as no wait', () => {
    expect(parseRetryAfter('Fri, 25 Sep 2026 09:00:00 GMT', now)).toBe(0);
  });

  it.each([null, undefined, '', 'soon', '1.5', '-3', '2026-09-25', 'Fri, 25 Sep 2026', '9'.repeat(400)])(
    'ignores %j',
    (value) => {
      expect(parseRetryAfter(value, now)).toBeUndefined();
    },
  );
});

describe('retryDelay()', () => {
  const retry = resolveRetry({ attempts: 5, backoff: { delay: 100, factor: 2, maxDelay: 2_000, jitter: 'none' } }, 'M');
  const throttled = (retryAfterMs?: number) => new MailProviderError({ provider: 'resend', status: 429, retryAfterMs });

  it('is the backoff without a retryAfterMs', () => {
    expect(retryDelay(retry, 2, throttled())).toBe(200);
    expect(retryDelay(retry, 2, new Error('reset'))).toBe(200);
  });

  it("waits at least the provider's Retry-After, up to maxDelay", () => {
    expect(retryDelay(retry, 1, throttled(1_500))).toBe(1_500);
    expect(retryDelay(retry, 1, throttled(60_000))).toBe(2_000);
    expect(retryDelay(retry, 4, throttled(50))).toBe(800);
  });

  it('caps it at the default maxDelay with a backoff function, which it never shortens', () => {
    expect(retryDelay(resolveRetry({ backoff: () => 10 }, 'M'), 1, throttled(5_000))).toBe(5_000);
    expect(retryDelay(resolveRetry({ backoff: () => 10 }, 'M'), 1, throttled(600_000))).toBe(30_000);
    expect(retryDelay(resolveRetry({ backoff: () => '1m' }, 'M'), 1, throttled(5_000))).toBe(60_000);
  });

  it("reads a custom transport's retryAfterMs, and ignores one that isn't a wait", () => {
    expect(retryDelay(retry, 1, Object.assign(new Error('busy'), { retryAfterMs: 900 }))).toBe(900);
    for (const retryAfterMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, '900']) {
      expect(retryDelay(retry, 1, Object.assign(new Error('busy'), { retryAfterMs }))).toBe(100);
    }
    expect(retryDelay(retry, 1, null)).toBe(100);
    expect(retryDelay(retry, 1, 'thrown string')).toBe(100);
  });
});

describe('sleep()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the delay', async () => {
    let done = false;
    const sleeping = sleep(1_000).then(() => (done = true));

    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
  });

  it('rejects with the reason of a signal that aborted before or during the wait, and clears its timer', async () => {
    const reason = new Error('stop');
    await expect(sleep(1_000, AbortSignal.abort(reason))).rejects.toBe(reason);

    const controller = new AbortController();
    const sleeping = sleep(60_000, controller.signal);
    controller.abort(reason);
    await expect(sleeping).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('errors', () => {
  it('share the MailError base, with their own name and a permanent flag', () => {
    const errors = [
      new MailConnectionError('x', { permanent: false }),
      new MailMessageError('to', 'is missing'),
      new MailProviderError({ provider: 'resend', status: 500 }),
      new MailSmtpError('DATA', { code: 554, text: 'no' }),
      new MailRecipientsRejectedError([{ address: 'a@example.com', code: 550, response: 'no' }]),
      new MailTimeoutError('greeting', 100),
    ];

    expect(errors.every((e) => e instanceof MailError && e instanceof Error)).toBe(true);
    expect(errors.map((e) => [e.name, e.permanent])).toEqual([
      ['MailConnectionError', false],
      ['MailMessageError', true],
      ['MailProviderError', false],
      ['MailSmtpError', true],
      ['MailRecipientsRejectedError', true],
      ['MailTimeoutError', false],
    ]);
    expect(errors[4]).toBeInstanceOf(MailSmtpError);
  });

  it('keep the cause, and leave code out when there is none', () => {
    const cause = new Error('ECONNRESET');
    const error = new MailConnectionError('reset', { permanent: false, cause });
    expect(error.cause).toBe(cause);
    expect(error).not.toHaveProperty('code');
    expect(new MailConnectionError('x', { permanent: false })).not.toHaveProperty('cause');
  });

  it('MailMessageError carries status 400 and the field', () => {
    const error = new MailMessageError('attachments[0].filename', 'is required');
    expect(error).toMatchObject({ status: 400, field: 'attachments[0].filename', message: 'Invalid mail: attachments[0].filename is required' });
  });

  it.each([
    [400, true],
    [401, true],
    [404, true],
    [408, false],
    [409, false],
    [422, true],
    [429, false],
    [500, false],
    [503, false],
  ])('MailProviderError: status %i is permanent=%s by default', (status, permanent) => {
    expect(new MailProviderError({ provider: 'p', status }).permanent).toBe(permanent);
  });

  it('MailProviderError: an explicit permanent wins, the detail is one short line, providerCode is optional', () => {
    const error = new MailProviderError({ provider: 'ses', status: 400, providerCode: 'Throttling', detail: `a\r\nb ${'x'.repeat(500)}`, permanent: false });
    expect(error.permanent).toBe(false);
    expect(error.code).toBe(400);
    expect(error.message).toMatch(/^ses refused the message with 400 Throttling: a b x+…$/);
    expect(error.message.length).toBeLessThan(360);

    const bare = new MailProviderError({ provider: 'postmark', status: 500 });
    expect(bare.message).toBe('postmark refused the message with 500');
    expect(bare).not.toHaveProperty('providerCode');
    expect(bare).not.toHaveProperty('retryAfterMs');
    expect(new MailProviderError({ provider: 'resend', status: 429, retryAfterMs: 7_000 }).retryAfterMs).toBe(7_000);
  });

  it('MailSmtpError: 4xx is transient, and the message names the command and the reply', () => {
    const error = new MailSmtpError('MAIL FROM', { code: 451, enhancedCode: '4.7.1', text: 'Greylisted' }, 'retry later');
    expect(error).toMatchObject({ permanent: false, code: 451, enhancedCode: '4.7.1', command: 'MAIL FROM', response: 'Greylisted' });
    expect(error.message).toBe('SMTP MAIL FROM failed with 451 4.7.1: Greylisted (retry later)');
    expect(new MailSmtpError('DATA', { code: 554, text: 'no' })).not.toHaveProperty('enhancedCode');
  });

  it('MailRecipientsRejectedError reports the worst refusal: a 5xx over an earlier 4xx', () => {
    const error = new MailRecipientsRejectedError([
      { address: 'full@example.com', code: 452, enhancedCode: '4.2.2', response: 'Mailbox full' },
      { address: 'gone@example.com', code: 550, enhancedCode: '5.1.1', response: 'No such user' },
    ]);

    expect(error).toMatchObject({ code: 550, enhancedCode: '5.1.1', permanent: true, command: 'RCPT TO', response: 'No such user' });
    expect(error.message).toBe('SMTP RCPT TO failed with 550 5.1.1: No such user (2 recipient(s) refused: full@example.com, gone@example.com)');
  });

  it('MailTimeoutError names the phase, the timeout and the detail', () => {
    expect(new MailTimeoutError('data', 300, 'smtp.example.com:587').message).toBe('Mail data timed out after 300ms (smtp.example.com:587)');
    expect(new MailTimeoutError('request', 50).message).toBe('Mail request timed out after 50ms');
  });

  it('truncate() flattens line breaks and cuts long replies', () => {
    expect(truncate('  a\r\nb\n\nc  ')).toBe('a b c');
    expect(truncate('abcdef', 3)).toBe('abc…');
    expect(truncate('abc', 3)).toBe('abc');
  });
});
