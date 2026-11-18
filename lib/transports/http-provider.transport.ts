import type { HttpProviderOptions } from '../interfaces/provider-transport-options.interface.js';
import { MailConnectionError } from '../errors/mail-connection.error.js';
import { MailProviderError } from '../errors/mail-provider.error.js';
import { MailTimeoutError } from '../errors/mail-timeout.error.js';
import { MailTransport } from './mail.transport.js';
import type { MailAddress } from '../interfaces/mail-message.interface.js';
import { parseRetryAfter } from '../utils/retry-after.util.js';
import { durationOption } from '../utils/retry.util.js';

export interface ProviderResponse {
  status: number;
  headers: Headers;
  body: unknown;
  /** The response's `Retry-After`, in ms from when it arrived. */
  retryAfterMs?: number;
}

/** The longest error body read into an error: enough for any provider's JSON. */
const MAX_ERROR_BODY = 16_384;

/**
 * The shared request path of the HTTP provider transports (internal): a timeout per
 * request combined with the caller's signal, and failures as `MailError`s. Network
 * errors and timeouts are transient; responses are classified by each provider.
 */
export abstract class HttpProviderTransport extends MailTransport {
  protected readonly timeout: number;
  private readonly fetchOverride?: typeof globalThis.fetch;

  protected constructor(
    protected readonly provider: string,
    options: HttpProviderOptions,
  ) {
    super();
    this.timeout = durationOption(options.timeout ?? '30s', `${this.constructor.name} \`timeout\``);
    if (options.fetch !== undefined && typeof options.fetch !== 'function') {
      throw new TypeError(`${this.constructor.name} \`fetch\` must be a function`);
    }
    this.fetchOverride = options.fetch;
  }

  /** Maps a non-2xx response to an error. */
  protected abstract toError(response: ProviderResponse): MailProviderError;

  protected async request(url: string, init: { headers: Record<string, string>; body: string }, signal: AbortSignal): Promise<ProviderResponse> {
    const timer = new AbortController();
    const timeout = setTimeout(
      () => timer.abort(new MailTimeoutError('request', this.timeout, `${this.provider} ${new URL(url).host}`)),
      this.timeout,
    );
    const combined = AbortSignal.any([signal, timer.signal]);

    try {
      const fetch = this.fetchOverride ?? globalThis.fetch;
      let response: Response;
      try {
        response = await fetch(url, { method: 'POST', headers: init.headers, body: init.body, signal: combined, redirect: 'error' });
      } catch (error) {
        throw this.networkError(error, signal, timer.signal, url);
      }

      let text: string;
      try {
        text = response.ok ? await response.text() : await readCapped(response);
      } catch (error) {
        throw this.networkError(error, signal, timer.signal, url);
      }

      const result: ProviderResponse = { status: response.status, headers: response.headers, body: parseJson(text) };
      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now());
        throw this.toError(retryAfterMs === undefined ? result : { ...result, retryAfterMs });
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  private networkError(error: unknown, signal: AbortSignal, timer: AbortSignal, url: string): unknown {
    if (signal.aborted) {
      return signal.reason;
    }
    if (timer.aborted) {
      return timer.reason;
    }

    const detail = (error as { cause?: { code?: string }; message?: string }) ?? {};
    return new MailConnectionError(
      `${this.provider} request to ${new URL(url).host} failed: ${detail.cause?.code ?? detail.message ?? 'network error'}`,
      { permanent: false, cause: error },
    );
  }
}

/** Reads at most 16 KiB of an error body and cancels the rest. */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_ERROR_BODY) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY).toString('utf8');
}

function parseJson(text: string): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `Name <address>` for JSON APIs, which take UTF-8 names as they are; quoted when it has specials. */
export function formatAddress({ name, address }: MailAddress): string {
  if (!name) {
    return address;
  }
  const display = /[()<>[\]:;@\\,."]/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name;
  return `${display} <${address}>`;
}

/** A string field of an unknown JSON body. */
export function field(body: unknown, ...names: string[]): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  for (const name of names) {
    const value = (body as Record<string, unknown>)[name];
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
  }
  return undefined;
}
