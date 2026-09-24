import { isIP, connect as netConnect, type Socket } from 'node:net';
import { hostname as osHostname } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { MailConnectionError } from '../errors/mail-connection.error.js';
import { MailRecipientsRejectedError } from '../errors/mail-recipients-rejected.error.js';
import { MailSmtpError } from '../errors/mail-smtp.error.js';
import { MailTimeoutError } from '../errors/mail-timeout.error.js';

export interface SmtpReply {
  code: number;
  enhancedCode?: string;
  /** Every line's text, without the code. */
  lines: string[];
  /** The lines joined with spaces, without the enhanced code. */
  text: string;
}

export interface SmtpTimeouts {
  connect: number;
  greeting: number;
  command: number;
  data: number;
}

export type SmtpAuth =
  | { user: string; pass: string }
  | { user: string; accessToken: string | (() => string | Promise<string>) };

export interface SmtpConnectOptions {
  host: string;
  port: number;
  secure: boolean;
  startTls: 'required' | 'opportunistic' | 'never';
  tls: Omit<ConnectionOptions, 'socket' | 'host' | 'port'>;
  name?: string;
  auth?: SmtpAuth;
  authMethod?: 'PLAIN' | 'LOGIN' | 'XOAUTH2';
  timeouts: SmtpTimeouts;
  signal?: AbortSignal;
}

export interface SmtpEnvelope {
  from: string;
  to: string[];
}

/** A server reply line can't be longer than this; a server that sends more is not an SMTP server. */
const MAX_LINE = 4096;
/** Lines in one multiline reply; EHLO, the longest, has a few dozen. */
const MAX_REPLY_LINES = 512;
/** Replies that arrived without a command waiting: a well-behaved server sends at most one (421). */
const MAX_QUEUED = 4;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$|\.localhost$/i;

export function isLoopback(host: string): boolean {
  return LOOPBACK.test(host);
}

/**
 * One SMTP session (RFC 5321): greeting, EHLO, STARTTLS, AUTH, then any number of
 * transactions. Commands run one at a time; replies are matched to them in order.
 */
export class SmtpConnection {
  capabilities = new Map<string, string>();
  /** Messages accepted on this connection. */
  messages = 0;
  /** Set once the connection can't be used any more. */
  closed = false;
  /** Whether the server accepted MAIL FROM in the last transaction: from then on, a retry could duplicate. */
  transactionStarted = false;
  private socket!: Socket | TLSSocket;
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private lines: string[] = [];
  private queued: SmtpReply[] = [];
  private waiter?: { resolve: (reply: SmtpReply) => void; reject: (error: unknown) => void };
  private failure?: unknown;
  private secure = false;

  private constructor(private readonly options: SmtpConnectOptions) {}

  /**
   * Connects, reads the greeting, says EHLO, upgrades with STARTTLS as configured, and
   * authenticates. Rejects (and closes the socket) on any failure.
   */
  static async open(options: SmtpConnectOptions): Promise<SmtpConnection> {
    const connection = new SmtpConnection(options);
    const onAbort = () => connection.destroy(options.signal!.reason);
    options.signal?.throwIfAborted();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await connection.handshake();
      return connection;
    } catch (error) {
      connection.destroy(error);
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  get isSecure(): boolean {
    return this.secure;
  }

  private async handshake(): Promise<void> {
    const { host, port, secure, timeouts } = this.options;
    const socket = await this.withTimeout(
      'connect',
      timeouts.connect,
      new Promise<Socket | TLSSocket>((resolve, reject) => {
        const s = secure
          ? tlsConnect({ ...this.tlsOptions(), host, port })
          : netConnect({ host, port });
        this.socket = s;
        s.once(secure ? 'secureConnect' : 'connect', () => resolve(s));
        s.once('error', (error) =>
          reject(new MailConnectionError(connectionMessage(this.options, error), { permanent: false, cause: error })),
        );
        // `destroy()` (an abort) closes the socket without an error: settle at once, not at the timeout
        s.once('close', () => reject(this.failure ?? new MailConnectionError(connectionMessage(this.options, undefined), { permanent: false })));
      }),
    );
    this.secure = secure;
    this.attach(socket);

    const greeting = await this.read('greeting', timeouts.greeting);
    if (greeting.code !== 220) {
      throw new MailSmtpError('greeting', greeting);
    }
    await this.ehlo();

    if (!this.secure && this.options.startTls !== 'never') {
      if (this.capabilities.has('STARTTLS')) {
        await this.startTls();
        await this.ehlo();
      } else if (this.options.startTls === 'required') {
        throw new MailConnectionError(
          `The SMTP server ${host}:${port} doesn't offer STARTTLS, which is required. Use \`secure: true\` ` +
            "for implicit TLS (port 465), or `startTls: 'opportunistic'` only for a trusted local relay.",
          { permanent: true },
        );
      }
    }

    if (this.options.auth) {
      await this.authenticate(this.options.auth);
    }
  }

  private tlsOptions(): ConnectionOptions {
    const { host } = this.options;
    return {
      minVersion: 'TLSv1.2',
      ...this.options.tls,
      // SNI takes a name, never an IP; identity is still checked against `host`
      ...(isIP(host) === 0 && { servername: this.options.tls.servername ?? host }),
    };
  }

  private attach(socket: Socket | TLSSocket): void {
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error) => this.fail(new MailConnectionError(connectionMessage(this.options, error), { permanent: false, cause: error })));
    socket.on('close', () =>
      this.fail(new MailConnectionError(`The SMTP server ${this.options.host} closed the connection`, { permanent: false })),
    );
  }

  private detach(socket: Socket | TLSSocket): void {
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!this.onLine(line)) {
        return;
      }
    }

    if (this.buffer.length > MAX_LINE) {
      this.protocolError('a reply line longer than 4096 characters');
    }
  }

  /** Returns false when the line broke the connection. */
  private onLine(line: string): boolean {
    const match = /^([2-5]\d\d)([ -]|$)(.*)$/.exec(line);
    if (!match || line.length > MAX_LINE) {
      this.protocolError(`a malformed reply line: ${JSON.stringify(line.slice(0, 80))}`);
      return false;
    }

    const [, code, separator] = match;
    if (this.lines.length && !this.lines[0].startsWith(code)) {
      this.protocolError('a multiline reply whose lines have different codes');
      return false;
    }

    this.lines.push(line);
    if (separator === '-') {
      if (this.lines.length > MAX_REPLY_LINES) {
        this.protocolError(`a reply of more than ${MAX_REPLY_LINES} lines`);
        return false;
      }
      return true;
    }

    const texts = this.lines.map((l) => l.slice(4));
    this.lines = [];
    const reply = toReply(Number(code), texts);

    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = undefined;
      resolve(reply);
    } else if (this.queued.push(reply) > MAX_QUEUED) {
      this.protocolError('replies to commands that were never sent');
      return false;
    }
    return true;
  }

  private protocolError(detail: string): void {
    this.destroy(new MailConnectionError(`The SMTP server ${this.options.host} sent ${detail}`, { permanent: false }));
  }

  private fail(error: unknown): void {
    this.closed = true;
    this.failure ??= error;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = undefined;
      reject(this.failure);
    }
  }

  /** Closes the socket at once; a command waiting for its reply rejects with `error`. */
  destroy(error?: unknown): void {
    this.fail(error ?? new MailConnectionError('The SMTP connection was closed', { permanent: false }));
    this.socket?.destroy();
  }

  /** Reads the next reply, or fails when `timeout` elapses first (and closes the connection). */
  read(phase: string, timeout: number): Promise<SmtpReply> {
    const next = this.queued.shift();
    if (next) {
      return Promise.resolve(next);
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    return this.withTimeout(
      phase,
      timeout,
      new Promise<SmtpReply>((resolve, reject) => {
        this.waiter = { resolve, reject };
      }),
    );
  }

  private withTimeout<T>(phase: string, timeout: number, promise: Promise<T>): Promise<T> {
    if (!timeout) {
      return promise;
    }

    let timer: NodeJS.Timeout;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new MailTimeoutError(phase, timeout, `${this.options.host}:${this.options.port}`);
          this.destroy(error);
          reject(error);
        }, timeout);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** Sends one command line and reads its reply. `line` never carries a line break (checked by callers). */
  async command(line: string, phase = 'command', timeout = this.options.timeouts.command): Promise<SmtpReply> {
    if (this.failure) {
      throw this.failure;
    }
    if (/[\r\n]/.test(line)) {
      throw new TypeError('SMTP command with a line break');
    }

    this.socket.write(`${line}\r\n`);
    return this.read(phase, timeout);
  }

  private async ehlo(): Promise<void> {
    const name = this.options.name ?? defaultName(this.socket.localAddress);
    let reply = await this.command(`EHLO ${name}`);
    if (reply.code === 500 || reply.code === 502) {
      // A server from before ESMTP: no extensions
      reply = await this.command(`HELO ${name}`);
      if (reply.code !== 250) {
        throw new MailSmtpError('HELO', reply);
      }
      this.capabilities = new Map();
      return;
    }

    if (reply.code !== 250) {
      throw new MailSmtpError('EHLO', reply);
    }

    this.capabilities = new Map();
    for (const line of reply.lines.slice(1)) {
      const [keyword, ...params] = line.trim().split(/[ =]/);
      const key = keyword.toUpperCase();
      // "AUTH=PLAIN LOGIN" is the pre-standard spelling some servers still send
      const value = params.join(' ');
      this.capabilities.set(key, key === 'AUTH' && this.capabilities.has('AUTH') ? `${this.capabilities.get('AUTH')} ${value}` : value);
    }
  }

  private async startTls(): Promise<void> {
    const reply = await this.command('STARTTLS');
    if (reply.code !== 220) {
      throw new MailSmtpError('STARTTLS', reply);
    }

    // Anything the server sent after its 220, before the handshake, was sent in plaintext
    // and must not be read as if it came over TLS (CVE-2011-0411 and its relatives).
    if (this.buffer.length || this.queued.length || this.lines.length) {
      throw new MailConnectionError(
        `The SMTP server ${this.options.host} sent data after agreeing to STARTTLS; refusing to continue`,
        { permanent: false },
      );
    }

    const plain = this.socket as Socket;
    this.detach(plain);
    // Errors now surface on the TLS socket; this keeps one on the raw socket from being unhandled
    plain.on('error', () => {});
    const secured = await this.withTimeout(
      'tls',
      this.options.timeouts.connect,
      new Promise<TLSSocket>((resolve, reject) => {
        const s = tlsConnect({ ...this.tlsOptions(), socket: plain, host: this.options.host });
        this.socket = s;
        s.once('secureConnect', () => resolve(s));
        s.once('error', (error) => reject(new MailConnectionError(connectionMessage(this.options, error), { permanent: false, cause: error })));
        s.once('close', () => reject(this.failure ?? new MailConnectionError(connectionMessage(this.options, undefined), { permanent: false })));
      }),
    );

    this.decoder = new StringDecoder('utf8');
    this.secure = true;
    this.attach(secured);
  }

  private async authenticate(auth: SmtpAuth): Promise<void> {
    const { host } = this.options;
    if (!this.secure && !isLoopback(host)) {
      throw new MailConnectionError(
        `Refusing to send SMTP credentials to ${host} over an unencrypted connection. ` +
          "Use STARTTLS (the default) or `secure: true`.",
        { permanent: true },
      );
    }

    const offered = (this.capabilities.get('AUTH') ?? '').toUpperCase().split(/\s+/).filter(Boolean);
    const method = this.options.authMethod ?? pickMethod(auth, offered);
    if (!method || (this.capabilities.has('AUTH') && !offered.includes(method))) {
      throw new MailConnectionError(
        `The SMTP server ${host} doesn't offer ${method ? `AUTH ${method}` : 'a supported AUTH mechanism'} ` +
          `(it offers: ${offered.join(' ') || 'none'})`,
        { permanent: true },
      );
    }

    const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
    let reply: SmtpReply;
    if (method === 'XOAUTH2') {
      if (!('accessToken' in auth)) {
        throw new TypeError('AUTH XOAUTH2 needs `auth.accessToken`');
      }
      const token = typeof auth.accessToken === 'function' ? await auth.accessToken() : auth.accessToken;
      // oxlint-disable-next-line no-control-regex -- matching control characters is the point
      if (typeof token !== 'string' || /[\x00-\x1f]/.test(token)) {
        throw new MailConnectionError('The XOAUTH2 access token must be a string without control characters', {
          permanent: true,
        });
      }
      reply = await this.command(`AUTH XOAUTH2 ${b64(`user=${auth.user}\x01auth=Bearer ${token}\x01\x01`)}`, 'command');
      if (reply.code === 334) {
        // The challenge carries a base64 JSON error; the client answers with an empty line
        reply = await this.command('');
      }
    } else if (method === 'PLAIN') {
      if (!('pass' in auth)) {
        throw new TypeError('AUTH PLAIN needs `auth.pass`');
      }
      reply = await this.command(`AUTH PLAIN ${b64(`\0${auth.user}\0${auth.pass}`)}`);
    } else {
      if (!('pass' in auth)) {
        throw new TypeError('AUTH LOGIN needs `auth.pass`');
      }
      reply = await this.command('AUTH LOGIN');
      if (reply.code === 334) {
        reply = await this.command(b64(auth.user));
      }
      if (reply.code === 334) {
        reply = await this.command(b64(auth.pass));
      }
    }

    if (reply.code !== 235) {
      // 535 (bad credentials) is permanent, 454 (temporary failure) transient
      throw new MailSmtpError('AUTH', reply, `AUTH ${method} as the configured user was refused`);
    }
  }

  /**
   * One mail transaction. Every recipient is offered before `DATA`; if any is refused,
   * the transaction is reset and nothing is sent, so a retry never delivers twice.
   */
  async send(
    envelope: SmtpEnvelope,
    data: Buffer,
    flags: { smtputf8: boolean; signal?: AbortSignal },
  ): Promise<SmtpReply> {
    const onAbort = () => this.destroy(flags.signal!.reason);
    flags.signal?.throwIfAborted();
    flags.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      return await this.transaction(envelope, data, flags.smtputf8);
    } finally {
      flags.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async transaction(envelope: SmtpEnvelope, data: Buffer, smtputf8: boolean): Promise<SmtpReply> {
    this.transactionStarted = false;

    const params: string[] = [];
    const size = Number(this.capabilities.get('SIZE'));
    if (size > 0 && data.length > size) {
      throw new MailSmtpError(
        'MAIL FROM',
        { code: 552, enhancedCode: '5.3.4', text: `The message (${data.length} bytes) exceeds the server's limit of ${size} bytes` },
        'checked before sending',
      );
    }
    if (this.capabilities.has('SIZE')) {
      params.push(`SIZE=${data.length}`);
    }
    if (smtputf8) {
      if (!this.capabilities.has('SMTPUTF8')) {
        throw new MailConnectionError(
          `The SMTP server ${this.options.host} doesn't support SMTPUTF8, which an address with non-ASCII characters needs`,
          { permanent: true },
        );
      }
      params.push('SMTPUTF8');
      if (this.capabilities.has('8BITMIME')) {
        params.push('BODY=8BITMIME');
      }
    }

    let reply = await this.command(`MAIL FROM:<${envelope.from}>${params.length ? ` ${params.join(' ')}` : ''}`);
    if (reply.code !== 250) {
      throw new MailSmtpError('MAIL FROM', reply);
    }
    this.transactionStarted = true;

    const rejected: MailRecipientsRejectedError['rejected'][number][] = [];
    for (const to of envelope.to) {
      reply = await this.command(`RCPT TO:<${to}>`);
      if (reply.code === 421) {
        throw new MailSmtpError('RCPT TO', reply);
      }
      if (reply.code !== 250 && reply.code !== 251 && reply.code !== 252) {
        rejected.push({ address: to, code: reply.code, ...(reply.enhancedCode && { enhancedCode: reply.enhancedCode }), response: reply.text });
      }
    }
    if (rejected.length) {
      throw new MailRecipientsRejectedError(rejected);
    }

    reply = await this.command('DATA');
    if (reply.code !== 354) {
      throw new MailSmtpError('DATA', reply);
    }
    // The transmission has the data timeout too: a server that stops reading would
    // otherwise hold the send (and a pooled connection) forever
    await this.withTimeout('data', this.options.timeouts.data, this.write(toSmtpData(data)));
    reply = await this.read('data', this.options.timeouts.data);
    if (reply.code !== 250) {
      throw new MailSmtpError('DATA', reply, 'the message was refused after it was transmitted');
    }

    this.messages++;
    return reply;
  }

  private write(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failure) {
        return reject(this.failure);
      }
      this.socket.write(data, (error) => (error ? reject(this.failure ?? error) : resolve()));
    });
  }

  /** Resets a transaction that failed, so the connection can be reused. False when that failed too. */
  async reset(): Promise<boolean> {
    try {
      return (await this.command('RSET')).code === 250;
    } catch {
      return false;
    }
  }

  /** Says QUIT and closes, without waiting more than a few seconds for the reply. */
  async quit(): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      await this.command('QUIT', 'command', 5_000);
    } catch {
      // Closing anyway
    } finally {
      this.closed = true;
      const socket = this.socket;
      socket.end();
      setTimeout(() => socket.destroy(), 2_000).unref();
    }
  }
}

function toReply(code: number, texts: string[]): SmtpReply {
  const match = /^([245])\.(\d{1,3})\.(\d{1,3})(?:\s+|$)/.exec(texts[texts.length - 1] ?? '');
  const enhanced = match && Number(match[1]) === Math.floor(code / 100) ? match[0].trim() : undefined;
  const strip = (text: string) => (enhanced && text.startsWith(enhanced) ? text.slice(enhanced.length).trim() : text.trim());
  return {
    code,
    ...(enhanced && { enhancedCode: enhanced }),
    lines: texts,
    text: texts.map(strip).join(' ').trim(),
  };
}

function pickMethod(auth: SmtpAuth, offered: string[]): 'PLAIN' | 'LOGIN' | 'XOAUTH2' | undefined {
  if ('accessToken' in auth) {
    return 'XOAUTH2';
  }
  if (offered.includes('PLAIN') || !offered.length) {
    return 'PLAIN';
  }
  if (offered.includes('LOGIN')) {
    return 'LOGIN';
  }
  return undefined;
}

/** The EHLO name: the host's name when it is fully qualified, else an address literal. */
function defaultName(localAddress: string | undefined): string {
  const name = osHostname();
  if (/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(name)) {
    return name;
  }
  if (!localAddress) {
    return '[127.0.0.1]';
  }
  const v4 = localAddress.replace(/^::ffff:/, '');
  return isIP(v4) === 4 ? `[${v4}]` : `[IPv6:${localAddress}]`;
}

function connectionMessage(options: SmtpConnectOptions, error: unknown): string {
  const detail = error as { code?: string; message?: string };
  return `SMTP connection to ${options.host}:${options.port} failed: ${detail?.code ?? detail?.message ?? 'unknown error'}`;
}

/**
 * The DATA payload: every line break as CRLF (a bare CR or LF becomes one, so the message
 * can't smuggle an end-of-data sequence past one server and not another), a `.` added in
 * front of every line that starts with one, and the terminating `.` line.
 */
export function toSmtpData(message: Buffer): Buffer {
  const out = Buffer.allocUnsafe(message.length * 2 + 5);
  let o = 0;
  let lineStart = true;

  for (let i = 0; i < message.length; i++) {
    const byte = message[i];
    if (byte === 0x0d || byte === 0x0a) {
      if (byte === 0x0d && message[i + 1] === 0x0a) {
        i++;
      }
      out[o++] = 0x0d;
      out[o++] = 0x0a;
      lineStart = true;
      continue;
    }
    if (lineStart && byte === 0x2e) {
      out[o++] = 0x2e;
    }
    out[o++] = byte;
    lineStart = false;
  }

  if (!lineStart) {
    out[o++] = 0x0d;
    out[o++] = 0x0a;
  }
  out[o++] = 0x2e;
  out[o++] = 0x0d;
  out[o++] = 0x0a;
  return out.subarray(0, o);
}
