import type {
  SmtpPoolOptions,
  SmtpTransportOptions,
} from '../interfaces/smtp-transport-options.interface.js';
import { MailConnectionError } from '../errors/mail-connection.error.js';
import { MailSmtpError } from '../errors/mail-smtp.error.js';
import { MailTransport } from '../transports/mail.transport.js';
import type { MailTransportResult, MailTransportSendOptions } from '../interfaces/mail-transport.interface.js';
import type { MailMessage } from '../message/mail-message.js';
import { durationOption } from '../utils/retry.util.js';
import { createDkimSigner, type DkimSigner } from './dkim.util.js';
import {
  isLoopback,
  type SmtpAuth,
  SmtpConnection,
  type SmtpConnectOptions,
  type SmtpTimeouts,
} from './smtp-connection.js';

interface ResolvedPool {
  maxConnections: number;
  maxMessages: number;
  idleTimeout: number;
}

interface Idle {
  connection: SmtpConnection;
  timer: NodeJS.Timeout;
}

/**
 * SMTP on `node:net` and `node:tls` (RFC 5321): implicit TLS or STARTTLS (required by
 * default), certificate verification, AUTH PLAIN, LOGIN and XOAUTH2, SIZE, SMTPUTF8,
 * optional DKIM signing and connection pooling.
 *
 * A reply of 4xx is a transient `MailSmtpError`, 5xx a permanent one. If any recipient
 * is refused, the transaction is reset before `DATA` and nothing is sent.
 */
export class SmtpTransport extends MailTransport {
  /** Holds the credentials: a private field, so logging the transport doesn't print them. */
  readonly #connect: Omit<SmtpConnectOptions, 'signal'>;
  private readonly pool?: ResolvedPool;
  private readonly dkim?: DkimSigner;
  private readonly idle: Idle[] = [];
  private readonly waiting: { resolve: (c: SmtpConnection | undefined) => void; reject: (e: unknown) => void }[] = [];
  /** Connections that went back to the pool at least once. */
  private readonly reused = new WeakSet<SmtpConnection>();
  private open = 0;
  private closed = false;

  constructor(options: SmtpTransportOptions) {
    super();

    const fromUrl = options.url === undefined ? {} : parseUrl(options.url);
    const host = options.host ?? fromUrl.host;
    if (typeof host !== 'string' || !host) {
      throw new TypeError('SmtpTransport `host` is required (or `url`)');
    }

    const secure = options.secure ?? fromUrl.secure ?? (options.port ?? fromUrl.port) === 465;
    const port = options.port ?? fromUrl.port ?? (secure ? 465 : 587);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new TypeError('SmtpTransport `port` must be 1-65535');
    }

    const startTls = options.startTls ?? (isLoopback(host) ? 'opportunistic' : 'required');
    if (!['required', 'opportunistic', 'never'].includes(startTls)) {
      throw new TypeError("SmtpTransport `startTls` must be 'required', 'opportunistic' or 'never'");
    }

    const auth = options.auth ?? fromUrl.auth;
    checkAuth(auth);
    if (options.name !== undefined && !/^[\x21-\x7e]{1,255}$/.test(options.name)) {
      throw new TypeError('SmtpTransport `name` must be a host name or an address literal, without spaces');
    }

    const t = options.timeouts ?? {};
    const timeouts: SmtpTimeouts = {
      connect: durationOption(t.connect ?? '30s', 'SmtpTransport `timeouts.connect`'),
      greeting: durationOption(t.greeting ?? '30s', 'SmtpTransport `timeouts.greeting`'),
      command: durationOption(t.command ?? '1m', 'SmtpTransport `timeouts.command`'),
      data: durationOption(t.data ?? '5m', 'SmtpTransport `timeouts.data`'),
    };

    this.#connect = {
      host,
      port,
      secure,
      startTls,
      tls: options.tls ?? {},
      ...(options.name !== undefined && { name: options.name }),
      ...(auth && { auth }),
      ...(options.authMethod && { authMethod: options.authMethod }),
      timeouts,
    };

    if (options.pool) {
      this.pool = resolvePool(options.pool === true ? {} : options.pool);
    }
    if (options.dkim) {
      this.dkim = createDkimSigner(options.dkim, 'SmtpTransport');
    }
  }

  async send(message: MailMessage, { signal }: MailTransportSendOptions): Promise<MailTransportResult> {
    const data = this.dkim ? this.dkim(message.toMime()) : message.toMime();
    const envelope = message.envelope;
    const smtputf8 = message.internationalized;

    for (let fresh = false; ; fresh = true) {
      const connection = await this.acquire(signal, fresh);
      const reused = this.reused.has(connection);
      try {
        const reply = await connection.send(envelope, data, { smtputf8, signal });
        this.release(connection);
        return { accepted: envelope.to, response: `${reply.code} ${reply.enhancedCode ? `${reply.enhancedCode} ` : ''}${reply.text}` };
      } catch (error) {
        await this.recover(connection, error);
        // A pooled connection the server dropped while it sat idle fails on MAIL FROM,
        // before anything was accepted: try once more on a new connection. Later failures
        // go to the caller, whose retry policy decides.
        if (reused && !fresh && !connection.transactionStarted && isStale(error) && !signal.aborted) {
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Connects, authenticates and says QUIT: checks host, port, TLS and credentials, e.g.
   * from a health check or a startup script. Throws the error `send()` would.
   */
  async verify(): Promise<void> {
    const connection = await SmtpConnection.open({ ...this.#connect });
    await connection.quit();
  }

  /** Closes idle connections, and the others as their sends finish. Later sends fail. */
  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter.reject(closedError());
    }
    await Promise.all(this.idle.splice(0).map(({ connection, timer }) => (clearTimeout(timer), this.retire(connection))));
  }

  private async acquire(signal: AbortSignal, fresh: boolean): Promise<SmtpConnection> {
    if (this.closed) {
      throw closedError();
    }

    if (this.pool && !fresh) {
      while (this.idle.length) {
        const { connection, timer } = this.idle.pop()!;
        clearTimeout(timer);
        if (!connection.closed) {
          return connection;
        }
        this.open--;
      }
      if (this.open >= this.pool.maxConnections) {
        const handed = await this.waitForConnection(signal);
        if (handed) {
          return handed;
        }
      }
    }

    this.open++;
    try {
      return await SmtpConnection.open({ ...this.#connect, signal });
    } catch (error) {
      this.open--;
      this.wakeOne();
      throw error;
    }
  }

  /** Resolves with a released connection, or `undefined` when a slot freed up for a new one. */
  private waitForConnection(signal: AbortSignal): Promise<SmtpConnection | undefined> {
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (connection: SmtpConnection | undefined) => {
          signal.removeEventListener('abort', onAbort);
          resolve(connection);
        },
        reject: (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        reject(signal.reason);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private release(connection: SmtpConnection): void {
    if (!this.pool || this.closed || connection.closed || connection.messages >= this.pool.maxMessages) {
      void this.retire(connection);
      return;
    }

    this.reused.add(connection);
    const waiter = this.waiting.shift();
    if (waiter) {
      return waiter.resolve(connection);
    }

    const timer = setTimeout(() => {
      const index = this.idle.findIndex((idle) => idle.connection === connection);
      if (index !== -1) {
        this.idle.splice(index, 1);
      }
      void this.retire(connection);
    }, this.pool.idleTimeout);
    timer.unref();
    this.idle.push({ connection, timer });
  }

  /** After a failed send: reset a healthy connection for reuse, drop a broken one. */
  private async recover(connection: SmtpConnection, error: unknown): Promise<void> {
    if (!connection.closed && error instanceof MailSmtpError && error.code !== 421) {
      // The server refused something but the session is fine
      if (this.pool && (await connection.reset())) {
        return this.release(connection);
      }
      return void this.retire(connection);
    }

    connection.destroy();
    this.open--;
    this.wakeOne();
  }

  private async retire(connection: SmtpConnection): Promise<void> {
    this.open--;
    this.wakeOne();
    await connection.quit();
  }

  /** A slot freed up: the first waiter opens a new connection. */
  private wakeOne(): void {
    if (!this.closed) {
      this.waiting.shift()?.resolve(undefined);
    }
  }
}

function isStale(error: unknown): boolean {
  return (error instanceof MailSmtpError && error.code === 421) || (error instanceof MailConnectionError && !error.permanent);
}

function closedError(): MailConnectionError {
  return new MailConnectionError('SmtpTransport is closed (the application is shutting down)', { permanent: false });
}

function resolvePool(pool: SmtpPoolOptions): ResolvedPool {
  const maxConnections = pool.maxConnections ?? 5;
  const maxMessages = pool.maxMessages ?? 100;

  if (!Number.isInteger(maxConnections) || maxConnections < 1) {
    throw new TypeError('SmtpTransport `pool.maxConnections` must be a whole number of at least 1');
  }
  if (!Number.isInteger(maxMessages) || maxMessages < 1) {
    throw new TypeError('SmtpTransport `pool.maxMessages` must be a whole number of at least 1');
  }

  return {
    maxConnections,
    maxMessages,
    idleTimeout: durationOption(pool.idleTimeout ?? '30s', 'SmtpTransport `pool.idleTimeout`'),
  };
}

function checkAuth(auth: SmtpAuth | undefined): void {
  if (auth === undefined) {
    return;
  }

  if (!auth || typeof auth.user !== 'string' || !auth.user) {
    throw new TypeError('SmtpTransport `auth.user` must be a non-empty string');
  }
  if ('pass' in auth) {
    if (typeof auth.pass !== 'string') {
      throw new TypeError('SmtpTransport `auth.pass` must be a string');
    }
  } else if (!('accessToken' in auth) || (typeof auth.accessToken !== 'string' && typeof auth.accessToken !== 'function')) {
    throw new TypeError('SmtpTransport `auth` needs `pass`, or `accessToken` for XOAUTH2');
  }
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  if (/[\x00-\x1f]/.test(auth.user)) {
    throw new TypeError('SmtpTransport `auth.user` contains a control character');
  }
}

/** `smtp[s]://[user[:pass]@]host[:port]`. Errors never repeat the URL: it holds the password. */
function parseUrl(url: string): { host?: string; port?: number; secure?: boolean; auth?: SmtpAuth } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('SmtpTransport `url` is not a valid URL (expected smtp://user:pass@host:587)');
  }

  if (parsed.protocol !== 'smtp:' && parsed.protocol !== 'smtps:') {
    throw new TypeError('SmtpTransport `url` must start with smtp:// or smtps://');
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    throw new TypeError('SmtpTransport `url` must not have a path');
  }
  if (parsed.search) {
    throw new TypeError('SmtpTransport `url` must not have a query string; use the options instead');
  }

  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      throw new TypeError('SmtpTransport `url` has a malformed percent-encoded user or password');
    }
  };

  return {
    host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'),
    ...(parsed.port && { port: Number(parsed.port) }),
    secure: parsed.protocol === 'smtps:',
    ...(parsed.username && { auth: { user: decode(parsed.username), pass: decode(parsed.password) } }),
  };
}
