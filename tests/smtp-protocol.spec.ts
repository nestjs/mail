import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import {
  MailConnectionError,
  MailRecipientsRejectedError,
  MailSmtpError,
  SmtpTransport,
  type SmtpTransportOptions,
} from '../lib/index.js';
import { createMailMessage, type NormalizeInput } from '../lib/message/normalize.util.js';
import { type FakeSmtpOptions, FakeSmtpServer } from './support/fake-smtp-server.js';

const USERS = { 'mailer@example.com': 's3cret-pass', 'oauth@example.com': 'ya29.token' };
const signal = () => new AbortController().signal;

async function until(condition: () => boolean, ms = 2_000) {
  for (const started = Date.now(); !condition(); ) {
    if (Date.now() - started > ms) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function message(input: Partial<NormalizeInput> = {}) {
  return createMailMessage(
    { to: 'ada@example.com', subject: 'Order #42', text: 'Thanks for your order.', ...input },
    { from: 'Orders <orders@example.com>' },
  );
}

const verbs = (commands: string[]) => commands.map((c) => c.split(' ')[0]);

describe('SmtpTransport protocol details', () => {
  let server: FakeSmtpServer;
  let raw: Server | undefined;
  const transports: SmtpTransport[] = [];

  async function start(options: FakeSmtpOptions = {}) {
    server = await new FakeSmtpServer({ users: USERS, ...options }).listen();
    return server;
  }

  /** Over STARTTLS, authenticated. */
  function transport(options: Partial<SmtpTransportOptions> = {}) {
    const t = new SmtpTransport({
      host: '127.0.0.1',
      port: server.port,
      startTls: 'required',
      tls: { ca: server.certificate.cert },
      auth: { user: 'mailer@example.com', pass: 's3cret-pass' },
      ...options,
    });
    transports.push(t);
    return t;
  }

  /** Plaintext to a local relay, without credentials: the socket the fake server records is the one it writes to. */
  function relay(options: Partial<SmtpTransportOptions> = {}) {
    return transport({ startTls: 'never', tls: undefined, auth: undefined, ...options });
  }

  async function rawServer(onConnection: (socket: Socket) => void) {
    raw = createServer(onConnection);
    await new Promise<void>((resolve) => raw!.listen(0, '127.0.0.1', resolve));
    return (raw.address() as AddressInfo).port;
  }

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
    await server?.close();
    raw?.close();
    raw = undefined;
  });

  describe('greeting and EHLO', () => {
    it('refuses a greeting other than 220, permanently for a 554', async () => {
      await start({ greeting: '554 5.3.2 No service for you' });
      const error = await relay().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);

      expect(error).toBeInstanceOf(MailSmtpError);
      expect(error).toMatchObject({ command: 'greeting', code: 554, enhancedCode: '5.3.2', permanent: true, response: 'No service for you' });
      expect(server.sessions[0].commands).toEqual([]);
    });

    it('introduces itself with the configured name, before and after STARTTLS', async () => {
      await start();
      await transport({ name: 'mailer.example.com' }).send(await message(), { signal: signal(), attempt: 1 });
      expect(server.sessions[0].commands.filter((c) => c.startsWith('EHLO'))).toEqual(['EHLO mailer.example.com', 'EHLO mailer.example.com']);
    });

    it('fails when EHLO is refused with something other than "not recognized"', async () => {
      await start({ reply: (c) => (c.startsWith('EHLO') ? '421 4.3.2 Too busy' : undefined) });
      const error = await relay().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toMatchObject({ command: 'EHLO', code: 421, permanent: false });
    });

    it('fails when the HELO fallback is refused too', async () => {
      await start({ reply: (c) => (c.startsWith('EHLO') ? '500 5.5.1 What?' : c.startsWith('HELO') ? '501 5.5.4 Bad name' : undefined) });
      const error = await relay().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toMatchObject({ command: 'HELO', code: 501, permanent: true });
    });

    it("stays in plaintext with startTls: 'never', even when the server offers STARTTLS", async () => {
      await start();
      await relay().send(await message(), { signal: signal(), attempt: 1 });
      await until(() => server.sessions[0].commands.at(-1) === 'QUIT');

      expect(verbs(server.sessions[0].commands)).toEqual(['EHLO', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
      expect(server.transactions[0].secure).toBe(false);
    });

    it('fails when the server refuses STARTTLS after offering it', async () => {
      await start({ reply: (c) => (c === 'STARTTLS' ? '454 4.7.0 TLS not available due to temporary reason' : undefined) });
      const error = await transport().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toMatchObject({ command: 'STARTTLS', code: 454, permanent: false });
      expect(server.transactions).toEqual([]);
    });
  });

  describe('authentication', () => {
    it('reads the pre-standard "AUTH=LOGIN" capability', async () => {
      await start({ extensions: ['AUTH=LOGIN'], authMechanisms: [] });
      await transport().send(await message(), { signal: signal(), attempt: 1 });

      expect(server.sessions[0].commands).toContain('AUTH LOGIN');
      expect(server.transactions[0].user).toBe('mailer@example.com');
    });

    it('prefers PLAIN when the server offers LOGIN too', async () => {
      await start({ authMechanisms: ['LOGIN', 'PLAIN'] });
      await transport().send(await message(), { signal: signal(), attempt: 1 });
      expect(server.sessions[0].commands.find((c) => c.startsWith('AUTH'))).toMatch(/^AUTH PLAIN /);
    });

    it('fails permanently when the forced mechanism is not offered', async () => {
      await start({ authMechanisms: ['PLAIN'] });
      const error = await transport({ authMethod: 'LOGIN' }).send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);

      expect(error).toBeInstanceOf(MailConnectionError);
      expect(error).toMatchObject({ permanent: true, message: "The SMTP server 127.0.0.1 doesn't offer AUTH LOGIN (it offers: PLAIN)" });
      expect(verbs(server.sessions[0].commands)).not.toContain('AUTH');
    });

    it('fails permanently when no offered mechanism fits a password', async () => {
      await start({ authMechanisms: ['XOAUTH2', 'CRAM-MD5'] });
      const error = await transport().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error.message).toBe("The SMTP server 127.0.0.1 doesn't offer a supported AUTH mechanism (it offers: XOAUTH2 CRAM-MD5)");
    });

    it('asks an accessToken function again for every new connection', async () => {
      await start({ authMechanisms: ['XOAUTH2'] });
      const accessToken = vi.fn(async () => 'ya29.token');
      const t = transport({ auth: { user: 'oauth@example.com', accessToken } });

      await t.send(await message(), { signal: signal(), attempt: 1 });
      await t.send(await message(), { signal: signal(), attempt: 1 });

      expect(accessToken).toHaveBeenCalledTimes(2);
      expect(server.transactions.map((tx) => tx.user)).toEqual(['oauth@example.com', 'oauth@example.com']);
    });

    it('refuses an access token with a line break before sending it', async () => {
      await start({ authMechanisms: ['XOAUTH2'] });
      const error = await transport({ auth: { user: 'oauth@example.com', accessToken: () => 'token\r\nMAIL FROM:<x@evil.example>' } })
        .send(await message(), { signal: signal(), attempt: 1 })
        .catch((e) => e);

      expect(error).toBeInstanceOf(MailConnectionError);
      expect(error).toMatchObject({ permanent: true, message: expect.stringMatching(/access token must be a string without control characters/) });
      expect(verbs(server.sessions[0].commands)).not.toContain('AUTH');
    });

    it('makes a 454 temporary authentication failure transient', async () => {
      await start({ reply: (c) => (c.startsWith('AUTH') ? '454 4.7.0 Temporary authentication failure' : undefined) });
      const error = await transport().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toMatchObject({ command: 'AUTH', code: 454, permanent: false });
      expect(error.message).toContain('AUTH PLAIN as the configured user was refused');
    });
  });

  describe('replies', () => {
    it('joins a multiline reply and strips the enhanced code from every line', async () => {
      await start({ dataReply: () => '550-5.7.1 Message rejected:\r\n550-5.7.1 see https://postmaster.example\r\n550 5.7.1 for details' });
      const error = await transport().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);

      expect(error).toMatchObject({
        command: 'DATA',
        code: 550,
        enhancedCode: '5.7.1',
        response: 'Message rejected: see https://postmaster.example for details',
      });
    });

    it('reports the final reply, with or without an enhanced code', async () => {
      await start({ dataReply: () => '250 Ok queued' });
      const result = await transport().send(await message(), { signal: signal(), attempt: 1 });
      expect(result.response).toBe('250 Ok queued');
    });

    it('ignores a status-code-like prefix whose class differs from the reply code', async () => {
      await start({ dataReply: () => '554 2.0.0 Not really ok' });
      const error = await transport().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toMatchObject({ code: 554, response: '2.0.0 Not really ok' });
      expect(error).not.toHaveProperty('enhancedCode');
    });

    it('gives up on a multiline reply whose lines have different codes', async () => {
      const port = await rawServer((socket) => socket.write('220-hello\r\n250 there\r\n'));
      const error = await new SmtpTransport({ host: '127.0.0.1', port }).send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(MailConnectionError);
      expect(error.message).toMatch(/a multiline reply whose lines have different codes/);
    });

    it('gives up on a server that sends replies to commands it never got', async () => {
      const port = await rawServer((socket) => socket.write('220 hello\r\n'.repeat(6)));
      const error = await new SmtpTransport({ host: '127.0.0.1', port }).send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error.message).toMatch(/replies to commands that were never sent/);
    });

    it('takes 251 and 252 as accepted recipients', async () => {
      await start({
        reply: (c) => (c === 'RCPT TO:<fwd@example.com>' ? '251 2.1.5 User not local; will forward' : c === 'RCPT TO:<vrfy@example.com>' ? '252 2.1.5 Cannot verify' : undefined),
      });
      await transport().send(await message({ to: ['fwd@example.com', 'vrfy@example.com', 'ada@example.com'] }), { signal: signal(), attempt: 1 });

      expect(server.transactions).toHaveLength(1);
      expect(server.sessions[0].commands.filter((c) => c.startsWith('RCPT'))).toHaveLength(3);
    });

    it('stops at a 421 during RCPT instead of collecting it as a refused recipient', async () => {
      await start({ reply: (c) => (c.startsWith('RCPT') ? '421 4.4.2 Closing, idle too long' : undefined) });
      const error = await transport().send(await message({ to: ['a@example.com', 'b@example.com'] }), { signal: signal(), attempt: 1 }).catch((e) => e);

      expect(error).toBeInstanceOf(MailSmtpError);
      expect(error).not.toBeInstanceOf(MailRecipientsRejectedError);
      expect(error).toMatchObject({ command: 'RCPT TO', code: 421, permanent: false });
      expect(server.sessions[0].commands.filter((c) => c.startsWith('RCPT'))).toHaveLength(1);
    });

    it('fails when the DATA command itself is refused', async () => {
      await start({ reply: (c) => (c === 'DATA' ? '554 5.5.1 No valid recipients' : undefined) });
      const error = await transport().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toMatchObject({ command: 'DATA', code: 554, permanent: true, message: 'SMTP DATA failed with 554 5.5.1: No valid recipients' });
    });

    it('announces no SIZE to a server without the extension, and SMTPUTF8 without BODY=8BITMIME when 8BITMIME is missing', async () => {
      await start({ extensions: ['SMTPUTF8'] });
      await transport().send(await message(), { signal: signal(), attempt: 1 });
      await transport().send(await message({ to: 'łucja@example.com' }), { signal: signal(), attempt: 1 });

      expect(server.transactions.map((tx) => tx.params)).toEqual([[], ['SMTPUTF8']]);
    });
  });

  describe('connections', () => {
    it('does not connect for a send whose signal has already aborted', async () => {
      await start();
      const reason = new Error('cancelled');
      await expect(transport().send(await message(), { signal: AbortSignal.abort(reason), attempt: 1 })).rejects.toBe(reason);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(server.sessions).toEqual([]);
    });

    it('quits (without RSET) after a refused recipient when not pooling', async () => {
      await start({ reply: (c) => (c.startsWith('RCPT') ? '550 5.1.1 No such user' : undefined) });
      await expect(relay().send(await message(), { signal: signal(), attempt: 1 })).rejects.toBeInstanceOf(MailRecipientsRejectedError);
      await until(() => server.sessions[0].commands.at(-1) === 'QUIT');

      expect(server.sessions[0].commands).not.toContain('RSET');
    });

    it('drops a pooled connection after a 421, and opens a new one for the next send', async () => {
      let refused = false;
      await start({
        reply: (c) => {
          if (c.startsWith('RCPT') && !refused) {
            refused = true;
            return '421 4.3.2 Shutting down';
          }
          return undefined;
        },
      });
      const t = relay({ pool: { maxConnections: 1 } });

      await expect(t.send(await message(), { signal: signal(), attempt: 1 })).rejects.toMatchObject({ code: 421 });
      await t.send(await message(), { signal: signal(), attempt: 1 });

      expect(server.sessions).toHaveLength(2);
      expect(server.sessions[0].commands).not.toContain('RSET');
      expect(server.transactions).toHaveLength(1);
    });

    it('retries once on a new connection when a reused one answers MAIL FROM with 421', async () => {
      await start({
        reply: (c, session) => (c.startsWith('MAIL') && session === server.sessions[0] && session.commands.includes('DATA') ? '421 4.4.2 Idle timeout' : undefined),
      });
      const t = relay({ pool: { maxConnections: 1 } });

      await t.send(await message({ subject: 'First' }), { signal: signal(), attempt: 1 });
      const result = await t.send(await message({ subject: 'Second' }), { signal: signal(), attempt: 1 });

      expect(result.accepted).toEqual(['ada@example.com']);
      expect(server.sessions).toHaveLength(2);
      expect(server.transactions).toHaveLength(2);
    });

    it('does not retry a 421 on MAIL FROM from a fresh connection', async () => {
      await start({ reply: (c) => (c.startsWith('MAIL') ? '421 4.3.2 Try later' : undefined) });
      await expect(relay({ pool: true }).send(await message(), { signal: signal(), attempt: 1 })).rejects.toMatchObject({ code: 421 });
      expect(server.sessions).toHaveLength(1);
    });

    it('lets a send waiting for a pooled connection be aborted, and close() fail the others', async () => {
      let hold = true;
      await start({ startTls: false, dataReply: () => (hold ? '' : '250 2.0.0 Ok') });
      const t = relay({ pool: { maxConnections: 1 } });

      const first = t.send(await message({ subject: 'Held' }), { signal: signal(), attempt: 1 });
      await until(() => server.transactions.length === 1);

      const controller = new AbortController();
      const reason = new Error('request closed');
      const aborted = t.send(await message(), { signal: controller.signal, attempt: 1 });
      const waiting = t.send(await message(), { signal: signal(), attempt: 1 });
      controller.abort(reason);
      await expect(aborted).rejects.toBe(reason);

      const closing = t.close();
      await expect(waiting).rejects.toThrow('SmtpTransport is closed (the application is shutting down)');

      hold = false;
      server.sessions[0].socket.write('250 2.0.0 Ok: queued late\r\n');
      await expect(first).resolves.toMatchObject({ response: '250 2.0.0 Ok: queued late' });
      await closing;
      expect(server.sessions).toHaveLength(1);
    });
  });

  describe('options', () => {
    it('lets fields next to url win over the url', async () => {
      await start({ startTls: false });
      const t = new SmtpTransport({ url: 'smtp://nobody.invalid:2525', host: '127.0.0.1', port: server.port, startTls: 'never' });
      transports.push(t);

      await t.send(await message(), { signal: signal(), attempt: 1 });
      expect(server.transactions).toHaveLength(1);
    });

    it.each([
      [{ auth: { user: 'u', pass: 42 } }, 'SmtpTransport `auth.pass` must be a string'],
      [{ auth: { user: 'u' } }, 'SmtpTransport `auth` needs `pass`, or `accessToken` for XOAUTH2'],
      [{ auth: { user: 'u', accessToken: 42 } }, 'SmtpTransport `auth` needs `pass`, or `accessToken` for XOAUTH2'],
      [{ auth: { user: 'u\r\nMAIL', pass: 'p' } }, 'SmtpTransport `auth.user` contains a control character'],
      [{ pool: { maxMessages: 0 } }, 'SmtpTransport `pool.maxMessages` must be a whole number of at least 1'],
      [{ pool: { maxConnections: 1.5 } }, 'SmtpTransport `pool.maxConnections` must be a whole number of at least 1'],
      [{ pool: { idleTimeout: 'forever' } }, 'SmtpTransport `pool.idleTimeout`'],
      [{ port: 0 }, 'SmtpTransport `port` must be 1-65535'],
      [{ url: 'not a url' }, 'SmtpTransport `url` is not a valid URL'],
      [{ dkim: { domainName: 'example.com', keySelector: 's1', privateKey: 'nope' } }, 'SmtpTransport `dkim.privateKey` is not a valid PEM private key'],
    ])('fails at startup on %j', (options, message) => {
      expect(() => new SmtpTransport({ host: 'smtp.example.com', ...(options as object) })).toThrow(message);
    });
  });
});
