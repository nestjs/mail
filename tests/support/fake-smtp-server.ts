import { createServer as createNetServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { createSecureContext, createServer as createTlsServer, TLSSocket } from 'node:tls';
import { selfSignedCertificate } from './certificate.js';

export interface FakeTransaction {
  from: string;
  params: string[];
  to: string[];
  /** The message as received: dot-unstuffed, without the terminating `.` line. */
  data: string;
  secure: boolean;
  user?: string;
}

export interface FakeSession {
  commands: string[];
  secure: boolean;
  user?: string;
  socket: Socket;
}

export interface FakeSmtpOptions {
  /** Implicit TLS on connect (port 465 style). */
  implicitTls?: boolean;
  /** Offer STARTTLS. Default true. */
  startTls?: boolean;
  /** Extra EHLO keywords, e.g. `['SIZE 1000', 'SMTPUTF8', '8BITMIME']`. Default: SIZE, 8BITMIME, SMTPUTF8, PIPELINING. */
  extensions?: string[];
  /** AUTH mechanisms offered after TLS. Default PLAIN LOGIN XOAUTH2. */
  authMechanisms?: string[];
  /** Offer AUTH before TLS too. Default false (as real submission servers do). */
  authBeforeTls?: boolean;
  /** Accepted credentials: user → password, or user → token for XOAUTH2. */
  users?: Record<string, string>;
  /**
   * Overrides the reply to a command. Return a reply (e.g. `'451 4.7.1 Try later'`), `'close'`
   * to drop the connection, or `undefined` for the default behavior.
   */
  reply?: (command: string, session: FakeSession) => string | undefined;
  /** The reply after the message data (`''`: none). Default `250 2.0.0 Ok: queued as <n>`. */
  dataReply?: (transaction: FakeTransaction) => string;
  /** Greeting line. Default `220 fake.smtp ESMTP`. */
  greeting?: string;
  /**
   * Sent in plaintext with the 220 to STARTTLS, in the same write: a response-injection
   * attempt, which reaches the client together with the 220.
   */
  injectAfterStartTls?: string;
}

/**
 * A scriptable SMTP server on `node:net`/`node:tls` for tests: EHLO, STARTTLS with a
 * certificate generated at startup, AUTH PLAIN/LOGIN/XOAUTH2, MAIL/RCPT/DATA with
 * dot-unstuffing, RSET, NOOP, QUIT. It records every session and transaction.
 */
export class FakeSmtpServer {
  readonly certificate = selfSignedCertificate();
  readonly sessions: FakeSession[] = [];
  readonly transactions: FakeTransaction[] = [];
  private server!: Server;
  private readonly sockets = new Set<Socket>();
  private queued = 0;

  constructor(private readonly options: FakeSmtpOptions = {}) {}

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async listen(): Promise<this> {
    const onConnection = (socket: Socket) => this.accept(socket, Boolean(this.options.implicitTls));
    this.server = this.options.implicitTls
      ? createTlsServer({ key: this.certificate.key, cert: this.certificate.cert }, onConnection)
      : createNetServer(onConnection);
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Drops every open connection, as a server does to idle clients. */
  dropConnections(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
  }

  private accept(raw: Socket, secure: boolean): void {
    this.sockets.add(raw);
    raw.on('close', () => this.sockets.delete(raw));
    raw.on('error', () => {});

    const session: FakeSession = { commands: [], secure, socket: raw };
    this.sessions.push(session);

    let socket = raw;
    let buffer = '';
    let decoder = new StringDecoder('utf8');
    let transaction: FakeTransaction | undefined;
    let inData = false;
    let pending: ((line: string) => void) | undefined;
    const write = (line: string) => socket.write(`${line}\r\n`);

    const extensions = () => {
      const auth = session.secure || this.options.authBeforeTls ? [`AUTH ${(this.options.authMechanisms ?? ['PLAIN', 'LOGIN', 'XOAUTH2']).join(' ')}`] : [];
      const tls = !session.secure && this.options.startTls !== false ? ['STARTTLS'] : [];
      return [...(this.options.extensions ?? ['SIZE 10485760', '8BITMIME', 'SMTPUTF8', 'PIPELINING']), ...tls, ...auth];
    };

    const onLine = (line: string) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          transaction!.data = transaction!.data.replace(/\r\n$/, '');
          this.transactions.push(transaction!);
          const reply = this.options.dataReply?.(transaction!) ?? `250 2.0.0 Ok: queued as Q${++this.queued}`;
          if (reply) {
            write(reply); // '' = never answer
          }
          transaction = undefined;
        } else {
          transaction!.data += `${line.startsWith('.') ? line.slice(1) : line}\r\n`;
        }
        return;
      }

      if (pending) {
        const next = pending;
        pending = undefined;
        return next(line);
      }

      session.commands.push(line);
      const scripted = this.options.reply?.(line, session);
      if (scripted === 'close') {
        return socket.destroy();
      }
      if (scripted !== undefined) {
        return write(scripted);
      }

      const [verb] = line.split(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO': {
          const lines = ['fake.smtp greets you', ...extensions()];
          lines.forEach((text, i) => write(`250${i === lines.length - 1 ? ' ' : '-'}${text}`));
          return;
        }
        case 'HELO':
          return write('250 fake.smtp');
        case 'STARTTLS': {
          const injected = this.options.injectAfterStartTls ? `${this.options.injectAfterStartTls}\r\n` : '';
          // One write, so the injected line reaches the client with the 220 on every platform
          socket.write(`220 2.0.0 Ready to start TLS\r\n${injected}`);

          raw.removeAllListeners('data');
          const secured = new TLSSocket(raw, {
            isServer: true,
            secureContext: createSecureContext({ key: this.certificate.key, cert: this.certificate.cert }),
          });
          secured.on('error', () => {});
          secured.on('data', onData);

          socket = secured;
          session.secure = true;
          buffer = '';
          decoder = new StringDecoder('utf8');
          return;
        }
        case 'AUTH':
          return this.auth(line, session, write, (handler) => (pending = handler));
        case 'MAIL': {
          const match = /^MAIL FROM:<([^>]*)>(.*)$/i.exec(line);
          if (!match) {
            return write('501 5.5.4 Syntax error');
          }
          transaction = { from: match[1], params: match[2].trim().split(' ').filter(Boolean), to: [], data: '', secure: session.secure, user: session.user };
          return write('250 2.1.0 Ok');
        }
        case 'RCPT': {
          const match = /^RCPT TO:<([^>]*)>$/i.exec(line);
          if (!transaction) {
            return write('503 5.5.1 Need MAIL first');
          }
          if (!match) {
            return write('501 5.5.4 Syntax error');
          }
          transaction.to.push(match[1]);
          return write('250 2.1.5 Ok');
        }
        case 'DATA':
          if (!transaction?.to.length) {
            return write('503 5.5.1 Need RCPT first');
          }
          inData = true;
          return write('354 End data with <CR><LF>.<CR><LF>');
        case 'RSET':
          transaction = undefined;
          return write('250 2.0.0 Ok');
        case 'NOOP':
          return write('250 2.0.0 Ok');
        case 'QUIT':
          write('221 2.0.0 Bye');
          return void socket.end();
        default:
          return write('502 5.5.2 Command not recognized');
      }
    };

    const onData = (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        onLine(line);
      }
    };

    raw.on('data', onData);
    write(this.options.greeting ?? '220 fake.smtp ESMTP');
  }

  private auth(
    line: string,
    session: FakeSession,
    write: (line: string) => void,
    await_: (handler: (line: string) => void) => void,
  ): void {
    const [, mechanism, initial] = line.split(' ');
    const users = this.options.users ?? {};

    const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');
    const finish = (user: string | undefined, ok: boolean) => {
      if (ok) {
        session.user = user;
        write('235 2.7.0 Authentication successful');
      } else {
        write('535 5.7.8 Authentication credentials invalid');
      }
    };

    switch (mechanism?.toUpperCase()) {
      case 'PLAIN': {
        const [, user, pass] = decode(initial ?? '').split('\0');
        return finish(user, users[user] === pass);
      }
      case 'LOGIN':
        write(`334 ${Buffer.from('Username:').toString('base64')}`);
        return await_((u) => {
          write(`334 ${Buffer.from('Password:').toString('base64')}`);
          await_((p) => finish(decode(u), users[decode(u)] === decode(p)));
        });
      case 'XOAUTH2': {
        const match = /^user=([^\x01]*)\x01auth=Bearer ([^\x01]*)\x01\x01$/.exec(decode(initial ?? ''));
        if (match && users[match[1]] === match[2]) {
          return finish(match[1], true);
        }
        write(`334 ${Buffer.from('{"status":"401","schemes":"bearer mac","scope":"https://mail.google.com/"}\n').toString('base64')}`);
        return await_((empty) => write(empty === '' ? '535 5.7.8 Username and Password not accepted' : '501 5.5.2 Expected an empty line'));
      }
      default:
        return write('504 5.5.4 Unrecognized authentication type');
    }
  }
}
