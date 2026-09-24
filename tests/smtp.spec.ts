import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { inspect } from 'node:util';
import {
  MailConnectionError,
  MailError,
  MailRecipientsRejectedError,
  MailSmtpError,
  MailTimeoutError,
  SmtpTransport,
  type SmtpTransportOptions,
} from '../lib/index.js';
import { createMailMessage, type NormalizeInput } from '../lib/message/normalize.util.js';
import { parseHeaderFields, relaxedBody, relaxedHeader } from '../lib/smtp/dkim.util.js';
import { isLoopback, toSmtpData } from '../lib/smtp/smtp-connection.js';
import { type FakeSmtpOptions, FakeSmtpServer } from './support/fake-smtp-server.js';
import { parseMessage } from './support/mime-parser.js';

const USERS = { 'mailer@acme.example': 's3cret-pass', 'oauth@acme.example': 'ya29.token' };
const signal = () => new AbortController().signal;

/** QUIT goes out after send() resolves: wait for it. */
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
    { from: 'Acme Books <orders@acme.example>' },
  );
}

describe('SmtpTransport', () => {
  let server: FakeSmtpServer;
  const transports: SmtpTransport[] = [];

  async function start(options: FakeSmtpOptions = {}) {
    server = await new FakeSmtpServer({ users: USERS, ...options }).listen();
    return server;
  }

  function transport(options: Partial<SmtpTransportOptions> = {}) {
    const t = new SmtpTransport({
      host: '127.0.0.1',
      port: server.port,
      startTls: 'required',
      tls: { ca: server.certificate.cert },
      auth: { user: 'mailer@acme.example', pass: 's3cret-pass' },
      ...options,
    });

    transports.push(t);
    return t;
  }

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
    await server?.close();
  });

  describe('TLS and authentication', () => {
    it('upgrades with STARTTLS, verifies the certificate, says EHLO again and authenticates', async () => {
      await start();
      const mail = await message();
      const result = await transport().send(mail, { signal: signal(), attempt: 1 });

      expect(result).toMatchObject({ accepted: ['ada@example.com'], response: expect.stringMatching(/^250 2\.0\.0 Ok: queued as Q1$/) });

      const [session] = server.sessions;
      await until(() => session.commands.at(-1) === 'QUIT');
      expect(session.commands.map((c) => c.split(' ')[0])).toEqual(['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);

      const [transaction] = server.transactions;
      expect(transaction).toMatchObject({ from: 'orders@acme.example', to: ['ada@example.com'], secure: true, user: 'mailer@acme.example' });
      expect(transaction.params).toEqual([`SIZE=${mail.toMime().length}`]);
      expect(`${transaction.data}\r\n`).toBe(mail.toMime().toString('utf8'));
    });

    it('speaks implicit TLS (secure: true, port 465 style)', async () => {
      await start({ implicitTls: true });
      await transport({ secure: true, startTls: undefined }).send(await message(), { signal: signal(), attempt: 1 });
      expect(server.sessions[0].commands[0]).toMatch(/^EHLO /);
      expect(server.transactions[0].secure).toBe(true);
    });

    it('refuses a certificate it cannot verify, before sending anything', async () => {
      await start();
      const error = await transport({ tls: {} })
        .send(await message(), { signal: signal(), attempt: 1 })
        .catch((e) => e);

      expect(error).toBeInstanceOf(MailConnectionError);
      expect(error.cause.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
      expect(server.sessions[0].commands).toEqual([expect.stringMatching(/^EHLO/), 'STARTTLS']);
      expect(server.transactions).toEqual([]);
    });

    it('refuses a certificate for another name', async () => {
      await start({ implicitTls: true });
      const error = await transport({ secure: true, tls: { ca: server.certificate.cert, servername: 'smtp.other.example' } })
        .send(await message(), { signal: signal(), attempt: 1 })
        .catch((e) => e);
      expect(error.cause.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    });

    it('fails permanently when STARTTLS is required but not offered', async () => {
      await start({ startTls: false, authBeforeTls: true });
      const error = await transport().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(MailConnectionError);
      expect(error).toMatchObject({ permanent: true, message: expect.stringMatching(/doesn't offer STARTTLS/) });
      expect(server.sessions[0].commands.map((c) => c.split(' ')[0])).toEqual(['EHLO']);
    });

    it('defaults to opportunistic STARTTLS for localhost, and required elsewhere', () => {
      expect(isLoopback('localhost')).toBe(true);
      expect(isLoopback('127.0.0.1')).toBe(true);
      expect(isLoopback('::1')).toBe(true);
      expect(isLoopback('mail.localhost')).toBe(true);
      expect(isLoopback('smtp.example.com')).toBe(false);
      expect(isLoopback('127.0.0.1.evil.example')).toBe(false);
    });

    it('sends to a local relay without TLS (opportunistic by default for localhost)', async () => {
      await start({ startTls: false, authBeforeTls: true });
      await transport({ startTls: undefined, tls: undefined, auth: undefined }).send(await message(), { signal: signal(), attempt: 1 });
      expect(server.transactions[0].secure).toBe(false);
    });

    it('never sends credentials over plaintext to a host that is not loopback', async () => {
      await start({ startTls: false, authBeforeTls: true });
      // The v4-mapped IPv6 spelling reaches the same local server but isn't a loopback name
      const error = await transport({ host: '::ffff:127.0.0.1', startTls: 'never' })
        .send(await message(), { signal: signal(), attempt: 1 })
        .catch((e) => e);

      expect(error).toMatchObject({ permanent: true, message: expect.stringMatching(/Refusing to send SMTP credentials/) });
      expect(server.sessions[0].commands.map((c) => c.split(' ')[0])).toEqual(['EHLO']);
    });

    it.each([
      ['PLAIN', ['PLAIN'], { user: 'mailer@acme.example', pass: 's3cret-pass' }],
      ['LOGIN', ['LOGIN'], { user: 'mailer@acme.example', pass: 's3cret-pass' }],
      ['XOAUTH2', ['XOAUTH2'], { user: 'oauth@acme.example', accessToken: async () => 'ya29.token' }],
    ] as const)('authenticates with AUTH %s', async (_name, mechanisms, auth) => {
      await start({ authMechanisms: [...mechanisms] });
      await transport({ auth }).send(await message(), { signal: signal(), attempt: 1 });
      expect(server.transactions[0].user).toBe(auth.user);
    });

    it('reports refused credentials as a permanent error without the password', async () => {
      await start();
      const error = await transport({ auth: { user: 'mailer@acme.example', pass: 'wrong-password' } })
        .send(await message(), { signal: signal(), attempt: 1 })
        .catch((e) => e);

      expect(error).toBeInstanceOf(MailSmtpError);
      expect(error).toMatchObject({ command: 'AUTH', code: 535, enhancedCode: '5.7.8', permanent: true });
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain('wrong-password');
      expect(server.transactions).toEqual([]);
    });

    it('answers an XOAUTH2 error challenge with an empty line, then reports the 535', async () => {
      await start({ authMechanisms: ['XOAUTH2'] });
      const error = await transport({ auth: { user: 'oauth@acme.example', accessToken: 'expired' } })
        .send(await message(), { signal: signal(), attempt: 1 })
        .catch((e) => e);

      expect(error).toMatchObject({ command: 'AUTH', code: 535, permanent: true });
      expect(server.sessions[0].commands.at(-1)).toMatch(/^AUTH XOAUTH2 /);
    });

    it('refuses a server that sends plaintext after agreeing to STARTTLS (response injection)', async () => {
      await start({ injectAfterStartTls: '250-INJECTED' });
      const error = await transport().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(MailConnectionError);
      expect(error.message).toMatch(/sent data after agreeing to STARTTLS/);
      expect(server.transactions).toEqual([]);
    });

    it('falls back to HELO for a server without ESMTP', async () => {
      await start({ reply: (c) => (c.startsWith('EHLO') ? '502 5.5.2 Command not recognized' : undefined) });
      await transport({ startTls: 'opportunistic', auth: undefined }).send(await message(), { signal: signal(), attempt: 1 });
      await until(() => server.sessions[0].commands.at(-1) === 'QUIT');
      expect(server.sessions[0].commands.map((c) => c.split(' ')[0])).toEqual(['EHLO', 'HELO', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    });
  });

  describe('reply codes', () => {
    it('makes a 4xx MAIL FROM reply a transient error', async () => {
      await start({ reply: (c) => (c.startsWith('MAIL') ? '451 4.7.1 Greylisted, try again later' : undefined) });
      const error = await transport().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(MailSmtpError);
      expect(error).toMatchObject({ command: 'MAIL FROM', code: 451, enhancedCode: '4.7.1', permanent: false, response: 'Greylisted, try again later' });
    });

    it('sends to nobody when a recipient is refused, and says which', async () => {
      await start({ reply: (c) => (c === 'RCPT TO:<nobody@example.com>' ? '550 5.1.1 <nobody@example.com>: User unknown' : undefined) });
      const error = await transport()
        .send(await message({ to: ['ada@example.com', 'nobody@example.com'] }), { signal: signal(), attempt: 1 })
        .catch((e) => e);

      expect(error).toBeInstanceOf(MailRecipientsRejectedError);
      expect(error).toMatchObject({
        permanent: true,
        code: 550,
        rejected: [{ address: 'nobody@example.com', code: 550, enhancedCode: '5.1.1', response: '<nobody@example.com>: User unknown' }],
      });
      expect(server.transactions).toEqual([]);
      expect(server.sessions[0].commands).not.toContain('DATA');
    });

    it('treats refused recipients as transient when every refusal is 4xx', async () => {
      await start({ reply: (c) => (c.startsWith('RCPT') ? '452 4.2.2 Mailbox full' : undefined) });
      const error = await transport().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toMatchObject({ permanent: false, code: 452 });
    });

    it.each([
      [554, true],
      [451, false],
    ])('maps a %i after the data to permanent=%s', async (code, permanent) => {
      await start({ dataReply: () => `${code} ${code >= 500 ? '5.7.1 Message rejected as spam' : '4.3.0 Try again'}` });
      const error = await transport().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toMatchObject({ command: 'DATA', code, permanent });
    });

    it('checks SIZE before sending anything', async () => {
      await start({ extensions: ['SIZE 1000'] });
      const error = await transport()
        .send(await message({ attachments: [{ filename: 'big.bin', content: Buffer.alloc(2000) }] }), { signal: signal(), attempt: 1 })
        .catch((e) => e);

      expect(error).toMatchObject({ code: 552, permanent: true });
      expect(server.sessions[0].commands.some((c) => c.startsWith('MAIL'))).toBe(false);
    });

    it('announces SMTPUTF8 for an internationalized address, and fails without server support', async () => {
      await start();
      await transport().send(await message({ to: 'łucja@example.com' }), { signal: signal(), attempt: 1 });

      expect(server.transactions[0].params).toEqual(expect.arrayContaining(['SMTPUTF8', 'BODY=8BITMIME']));
      expect(server.transactions[0].to).toEqual(['łucja@example.com']);
      await server.close();

      await start({ extensions: ['8BITMIME'] });
      const error = await transport().send(await message({ to: 'łucja@example.com' }), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toMatchObject({ permanent: true, message: expect.stringMatching(/SMTPUTF8/) });
    });
  });

  describe('data transparency', () => {
    it('dot-stuffs, and normalizes bare CR and LF so no end-of-data can be smuggled', () => {
      const raw = Buffer.from('a\r\n.\r\nMAIL FROM:<x>\n.\nb\r.\r\n..c\r\nend', 'latin1');
      expect(toSmtpData(raw).toString('latin1')).toBe('a\r\n..\r\nMAIL FROM:<x>\r\n..\r\nb\r\n..\r\n...c\r\nend\r\n.\r\n');
      expect(toSmtpData(Buffer.from('.only')).toString()).toBe('..only\r\n.\r\n');
    });

    it('delivers text that looks like SMTP intact, as one message', async () => {
      await start();
      const text = 'Line one\n.\nMAIL FROM:<attacker@evil.example>\r\n.\r\n.leading dot\n..two dots';
      const mail = await message({ text });
      await transport().send(mail, { signal: signal(), attempt: 1 });

      expect(server.transactions).toHaveLength(1);
      const parsed = parseMessage(`${server.transactions[0].data}\r\n`);
      expect(parsed.body.toString()).toBe(`${text.replace(/\r\n|\n/g, '\r\n')}\r\n`);
    });

    it('signs with DKIM so the received message verifies', async () => {
      await start();
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      await transport({ dkim: { domainName: 'acme.example', keySelector: 's1', privateKey } }).send(
        await message({ html: '<p>Signed</p>' }),
        { signal: signal(), attempt: 1 },
      );

      const received = `${server.transactions[0].data}\r\n`;
      const split = received.indexOf('\r\n\r\n');
      const fields = parseHeaderFields(received.slice(0, split + 2));
      const dkim = fields.find((f) => f.name === 'DKIM-Signature')!;
      const tags = Object.fromEntries(
        dkim.raw.slice(15).replace(/\s+/g, '').split(';').map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)]),
      );

      expect(createHash('sha256').update(relaxedBody(received.slice(split + 4))).digest('base64')).toBe(tags.bh);

      const used = new Map<string, number>();
      let data = '';
      for (const name of tags.h.split(':')) {
        const matching = fields.filter((f) => f.name.toLowerCase() === name);
        const i = matching.length - 1 - (used.get(name) ?? 0);
        used.set(name, (used.get(name) ?? 0) + 1);
        if (i >= 0) {
          data += `${relaxedHeader(matching[i].raw)}\r\n`;
        }
      }
      data += relaxedHeader(dkim.raw.replace(/(\bb=)[^;]*$/, '$1'));
      expect(verify(null, createHash('sha256').update(data).digest(), publicKey, Buffer.from(tags.b, 'base64'))).toBe(true);
    });
  });

  describe('timeouts and misbehaving servers', () => {
    let raw: Server;
    afterEach(() => raw?.close());

    async function rawServer(onConnection: (socket: import('node:net').Socket) => void) {
      raw = createServer(onConnection);
      await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
      return (raw.address() as AddressInfo).port;
    }

    it('times out waiting for the greeting', async () => {
      const port = await rawServer(() => {});
      await start(); // for afterEach
      const error = await new SmtpTransport({ host: '127.0.0.1', port, timeouts: { greeting: 100 } })
        .send(await message(), { signal: signal(), attempt: 1 })
        .catch((e) => e);

      expect(error).toBeInstanceOf(MailTimeoutError);
      expect(error).toMatchObject({ phase: 'greeting', timeoutMs: 100, permanent: false });
    });

    it('times out waiting for the reply to the data', async () => {
      await start({ dataReply: () => '' }); // an empty line is not a reply: the client keeps waiting
      const error = await transport({ timeouts: { data: 150 } }).send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toMatchObject({ name: 'MailTimeoutError', phase: 'data' });
    });

    it('times out transmitting the data to a server that stops reading', async () => {
      await start({
        startTls: false,
        extensions: [], // no SIZE limit
        reply: (c, session) => {
          if (c === 'DATA') {
            session.socket.pause(); // the kernel buffers fill, the write never completes
          }
          return undefined;
        },
      });

      const big = await message({ attachments: [{ filename: 'big.bin', content: Buffer.alloc(16 * 1024 * 1024, 7) }] });
      const t = transport({ startTls: 'never', tls: undefined, auth: undefined, timeouts: { data: 300 } });
      const started = performance.now();
      const error = await t.send(big, { signal: signal(), attempt: 1 }).catch((e) => e);

      expect(error).toBeInstanceOf(MailTimeoutError);
      expect(error).toMatchObject({ phase: 'data', timeoutMs: 300 });
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(server.transactions).toEqual([]);
    });

    it('gives up on a server that sends an endless line', async () => {
      const port = await rawServer((socket) => socket.write('220 '.padEnd(10_000, 'x')));
      await start();
      const error = await new SmtpTransport({ host: '127.0.0.1', port }).send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(MailConnectionError);
      expect(error.message).toMatch(/longer than 4096/);
    });

    it('gives up on a malformed reply', async () => {
      const port = await rawServer((socket) => socket.write('HTTP/1.1 400 Bad Request\r\n'));
      await start();
      const error = await new SmtpTransport({ host: '127.0.0.1', port }).send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error.message).toMatch(/malformed reply line/);
    });

    it('reports a refused connection as transient', async () => {
      const port = await rawServer(() => {});
      raw.close();
      await start();
      const error = await new SmtpTransport({ host: '127.0.0.1', port }).send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(MailConnectionError);
      expect(error).toMatchObject({ permanent: false, cause: { code: 'ECONNREFUSED' } });
    });

    it('treats a 421 as transient', async () => {
      await start({ reply: (c) => (c.startsWith('MAIL') ? '421 4.3.2 Shutting down' : undefined) });
      const error = await transport().send(await message(), { signal: signal(), attempt: 1 }).catch((e) => e);
      expect(error).toMatchObject({ code: 421, permanent: false });
    });

    it('stops at once when the caller aborts during the connection or the STARTTLS handshake', async () => {
      // A server that accepts the connection and never speaks TLS: the handshake waits
      const port = await rawServer(() => {});
      await start();
      const controller = new AbortController();
      const reason = new Error('publishTimeout');
      const t = new SmtpTransport({ host: '127.0.0.1', port, secure: true, timeouts: { connect: '30s' } });

      const started = performance.now();
      const sending = t.send(await message(), { signal: controller.signal, attempt: 1 });
      setTimeout(() => controller.abort(reason), 50);
      await expect(sending).rejects.toBe(reason);
      expect(performance.now() - started).toBeLessThan(2_000);

      // The same during the STARTTLS upgrade: 220, then silence
      await server.close();
      await start({ reply: (c, session) => (c === 'STARTTLS' ? (session.socket.removeAllListeners('data'), '220 go') : undefined) });

      const upgrade = new AbortController();
      const later = transport().send(await message(), { signal: upgrade.signal, attempt: 1 });
      setTimeout(() => upgrade.abort(reason), 50);
      await expect(later).rejects.toBe(reason);
      expect(performance.now() - started).toBeLessThan(4_000);
    });

    it('stops at once when the caller aborts', async () => {
      await start({ dataReply: () => '' });
      const controller = new AbortController();
      const reason = new Error('client went away');
      const sending = transport().send(await message(), { signal: controller.signal, attempt: 1 });
      setTimeout(() => controller.abort(reason), 100);
      await expect(sending).rejects.toBe(reason);
    });
  });

  describe('pooling', () => {
    it('reuses connections up to maxConnections and maxMessages', async () => {
      await start();
      const t = transport({ pool: { maxConnections: 2, maxMessages: 3 } });
      const mails = await Promise.all(Array.from({ length: 7 }, (_, i) => message({ to: `u${i}@example.com` })));
      await Promise.all(mails.map((m) => t.send(m, { signal: signal(), attempt: 1 })));

      expect(server.transactions).toHaveLength(7);
      // 7 messages, at most 3 per connection: at least 3 sessions, never more than 2 at a time
      expect(server.sessions.length).toBeGreaterThanOrEqual(3);
      const perSession = server.sessions.map((s) => s.commands.filter((c) => c === 'DATA').length);
      expect(Math.max(...perSession)).toBeLessThanOrEqual(3);
    });

    it('never has more than maxConnections open at once', async () => {
      let open = 0;
      let peak = 0;
      await start({
        reply: (c, session) => {
          if (c.startsWith('EHLO') && !session.secure) {
            open++;
            peak = Math.max(peak, open);
            session.socket.once('close', () => open--);
          }
          return undefined;
        },
      });

      const t = transport({ pool: { maxConnections: 2 } });
      const mails = await Promise.all(Array.from({ length: 6 }, () => message()));
      await Promise.all(mails.map((m) => t.send(m, { signal: signal(), attempt: 1 })));

      expect(peak).toBeLessThanOrEqual(2);
      expect(server.transactions).toHaveLength(6);
    });

    it('replaces a pooled connection the server dropped while idle, without sending twice', async () => {
      await start();
      const t = transport({ pool: { maxConnections: 1 } });

      await t.send(await message(), { signal: signal(), attempt: 1 });
      server.dropConnections();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await t.send(await message({ subject: 'Second' }), { signal: signal(), attempt: 1 });

      expect(server.transactions.map((tx) => parseMessage(`${tx.data}\r\n`).headers.find(([n]) => n === 'Subject')?.[1])).toEqual([
        'Order #42',
        'Second',
      ]);
      expect(server.sessions).toHaveLength(2);
    });

    it('resets and reuses the connection after a refused recipient', async () => {
      await start({ reply: (c) => (c === 'RCPT TO:<nobody@example.com>' ? '550 5.1.1 User unknown' : undefined) });
      const t = transport({ pool: true });
      await expect(t.send(await message({ to: 'nobody@example.com' }), { signal: signal(), attempt: 1 })).rejects.toThrow(MailRecipientsRejectedError);
      await t.send(await message(), { signal: signal(), attempt: 1 });

      expect(server.sessions).toHaveLength(1);
      expect(server.sessions[0].commands).toContain('RSET');
      expect(server.transactions).toHaveLength(1);
    });

    it('closes idle connections after idleTimeout, and all of them on close()', async () => {
      await start();
      const t = transport({ pool: { idleTimeout: 50 } });

      await t.send(await message(), { signal: signal(), attempt: 1 });
      expect(server.sessions[0].commands.at(-1)).toBe('DATA'); // kept open, idle
      await until(() => server.sessions[0].commands.at(-1) === 'QUIT');

      await t.send(await message(), { signal: signal(), attempt: 1 });
      await t.close();
      expect(server.sessions[1].commands.at(-1)).toBe('QUIT'); // close() waits for it
      await expect(t.send(await message(), { signal: signal(), attempt: 1 })).rejects.toThrow(/SmtpTransport is closed/);
    });
  });

  describe('configuration', () => {
    it('parses an smtp(s) URL (percent-encoded user and password), and never repeats it in errors', async () => {
      await start({ implicitTls: true, users: { 'mailer@acme.example': 'p@ss:word' } });
      const t = new SmtpTransport({ url: `smtps://mailer%40acme.example:p%40ss%3Aword@127.0.0.1:${server.port}`, tls: { ca: server.certificate.cert } });
      transports.push(t);

      await t.send(await message(), { signal: signal(), attempt: 1 });
      expect(server.transactions[0]).toMatchObject({ secure: true, user: 'mailer@acme.example' });

      const secret = 'hunter2-very-secret';
      for (const url of [`ftp://u:${secret}@h`, `smtp://u:${secret}@h/path`, `smtp://u:${secret}@h?x=1`, `smtp://u:%E0%A4%A@h`]) {
        let text = '';
        try {
          new SmtpTransport({ url });
        } catch (error) {
          text = (error as Error).message;
        }
        expect(text).toMatch(/SmtpTransport `url`/);
        expect(text).not.toContain(secret);
      }
    });

    it('keeps credentials out of logs: inspecting a transport shows none', () => {
      const t = new SmtpTransport({ host: 'smtp.acme.example', auth: { user: 'mailer', pass: 'hunter2-very-secret' } });
      expect(inspect(t, { depth: 10, showHidden: true })).not.toContain('hunter2');
      expect(JSON.stringify(t)).not.toContain('hunter2');
    });

    it('fails at startup on invalid options, naming them', () => {
      expect(() => new SmtpTransport({})).toThrow(/`host` is required/);
      expect(() => new SmtpTransport({ host: 'h', port: 70_000 })).toThrow(/`port`/);
      expect(() => new SmtpTransport({ host: 'h', timeouts: { data: '5 minutes' as never } })).toThrow(/timeouts\.data/);
      expect(() => new SmtpTransport({ host: 'h', pool: { maxConnections: 0 } })).toThrow(/pool\.maxConnections/);
      expect(() => new SmtpTransport({ host: 'h', auth: { user: '' } as never })).toThrow(/auth\.user/);
      expect(() => new SmtpTransport({ host: 'h', name: 'has space' })).toThrow(/`name`/);
      expect(() => new SmtpTransport({ host: 'h', startTls: 'maybe' as never })).toThrow(/startTls/);
    });

    it('verify() connects, authenticates and quits', async () => {
      await start();
      await transport().verify();
      expect(server.sessions[0].commands.map((c) => c.split(' ')[0])).toEqual(['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'QUIT']);
      await expect(transport({ auth: { user: 'mailer@acme.example', pass: 'nope' } }).verify()).rejects.toBeInstanceOf(MailError);
    });
  });
});
