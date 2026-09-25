import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Injectable,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import diagnostics from 'node:diagnostics_channel';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import {
  html,
  MailError,
  MailEvents,
  Mailer,
  MailModule,
  MailTransport,
  SmtpTransport,
  type Mailable,
  type MailAddressInput,
  type MailEvent,
  type MailModuleOptions,
  type MailRenderContext,
  type MailSendOptions,
  type MailSendResult,
  type SmtpTransportOptions,
} from '../lib/index.js';
import { FakeSmtpServer, type FakeSmtpOptions } from './support/fake-smtp-server.js';
import { settle, received, verifyDkim } from './support/integration.js';
import { decodeWords, header, headerAll, leaves, lint, parseAddresses, parseContentType, parseMessage } from './support/mime-parser.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
const PDF = Buffer.from('%PDF-1.7 \x00\xff\xfe binary', 'latin1');

interface OrderMailData {
  name: string;
  orderNumber: number;
}

@Injectable()
class OrderMail implements Mailable<OrderMailData> {
  readonly contexts: MailRenderContext[] = [];

  render({ name, orderNumber }: OrderMailData, context: MailRenderContext) {
    this.contexts.push(context);
    return {
      subject: `Zamówienie #${orderNumber}: dziękujemy, ${name}!`,
      html: html`<p><img src="cid:logo@example.com" alt="Logo"></p>
        <p>Cześć ${name},</p>
        <p><a href="${`https://shop.example.com/orders/${orderNumber}?ref=mail&lang=pl`}">Zobacz zamówienie</a></p>`,
      attachments: [
        { cid: 'logo@example.com', content: PNG, contentType: 'image/png' },
        { filename: 'faktura-żółw.pdf', content: Readable.from([PDF.subarray(0, 5), PDF.subarray(5)]) },
      ],
      headers: { 'List-Unsubscribe': '<https://shop.example.com/unsubscribe?u=1>' },
    };
  }
}

interface OrderRequest {
  to: MailAddressInput | MailAddressInput[];
  cc?: MailAddressInput[];
  bcc?: MailAddressInput[];
  name: string;
  idempotencyKey?: string;
  terms?: string;
}

/** Sends started by `POST /mail/background`, which answers before they finish. */
@Injectable()
class Background {
  readonly sends: Promise<MailSendResult | unknown>[] = [];
}

/** Maps mail errors to HTTP answers a test can read: 422 for permanent ones, 503 otherwise. */
async function answer(send: Promise<MailSendResult>): Promise<MailSendResult> {
  try {
    return await send;
  } catch (error) {
    if (!(error instanceof MailError)) {
      throw error;
    }
    const { name, permanent, code, message } = error;
    const extra = error as unknown as Record<string, unknown>;
    throw new HttpException(
      { name, permanent, code, message, enhancedCode: extra.enhancedCode, command: extra.command, rejected: extra.rejected },
      permanent ? 422 : 503,
    );
  }
}

@Controller('mail')
class MailController {
  constructor(
    private readonly mailer: Mailer,
    private readonly transport: MailTransport,
    private readonly background: Background,
  ) {}

  @Post('orders')
  order(@Body() body: OrderRequest) {
    return answer(
      this.mailer.send(OrderMail, {
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        data: { name: body.name, orderNumber: 1001 },
        idempotencyKey: body.idempotencyKey,
        attachments: body.terms ? [{ path: body.terms }] : [],
      }),
    );
  }

  @Post('plain')
  plain(@Body() body: MailSendOptions) {
    return answer(this.mailer.send(body));
  }

  @Post('background')
  @HttpCode(202)
  later(@Body() body: MailSendOptions) {
    this.background.sends.push(this.mailer.send(body).catch((error: unknown) => error));
  }

  @Get('health')
  async health() {
    await (this.transport as SmtpTransport).verify();
    return { ok: true };
  }
}

function appModule(options: MailModuleOptions) {
  @Module({ imports: [MailModule.forRoot(options)], controllers: [MailController], providers: [OrderMail, Background] })
  class AppModule {}
  return AppModule;
}

describe.each(adapters)('sending through SMTP from an app ($name)', ({ name }) => {
  let server: FakeSmtpServer;
  let app: INestApplication;
  let events: MailEvent[];
  let eventsCompleted: boolean;

  async function boot(serverOptions: FakeSmtpOptions, transportOptions: SmtpTransportOptions = {}, moduleOptions: Partial<MailModuleOptions> = {}) {
    server = await new FakeSmtpServer({ users: { mailer: 's3cret' }, ...serverOptions }).listen();
    const transport = new SmtpTransport({
      host: '127.0.0.1',
      port: server.port,
      tls: { ca: server.certificate.cert },
      auth: { user: 'mailer', pass: 's3cret' },
      ...transportOptions,
    });

    app = await createApp(name, appModule({
      transport,
      from: 'Orders <orders@example.com>',
      replyTo: 'Support <support@example.com>',
      headers: { 'X-Mailer-App': 'cat-store' },
      retry: { attempts: 3, backoff: { delay: 0, jitter: 'none' } },
      ...moduleOptions,
    }), { setup: (app) => app.useLogger(false) });

    events = [];
    eventsCompleted = false;
    app.get(MailEvents).events$.subscribe({ next: (event) => events.push(event), complete: () => (eventsCompleted = true) });
    return transport;
  }

  const http = () => request(app.getHttpServer());

  afterEach(async () => {
    await app?.close();
    await server?.close();
  });

  describe('TLS and authentication', () => {
    it('upgrades with STARTTLS, says EHLO again, authenticates with PLAIN and sends over the encrypted connection', async () => {
      await boot({ authMechanisms: ['PLAIN', 'LOGIN'] }, { startTls: 'required' });

      const { body } = await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' }).expect(201);

      expect(body).toMatchObject({ accepted: ['ada@example.com'], attempts: 1, response: expect.stringContaining('queued as Q1') });
      const [session] = server.sessions;
      expect(session.commands.filter((c) => c.startsWith('EHLO'))).toHaveLength(2);
      expect(session.commands.indexOf('STARTTLS')).toBeLessThan(session.commands.findIndex((c) => c.startsWith('AUTH')));
      expect(session.commands.find((c) => c.startsWith('AUTH'))).toMatch(/^AUTH PLAIN /);
      expect(server.transactions[0]).toMatchObject({ secure: true, user: 'mailer', from: 'orders@example.com', to: ['ada@example.com'] });
    });

    it('authenticates with LOGIN when that is what the server offers', async () => {
      await boot({ authMechanisms: ['LOGIN'] });

      await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' }).expect(201);

      const commands = server.sessions[0].commands;
      expect(commands).toContain('AUTH LOGIN');
      expect(commands.join('\n')).not.toContain('s3cret');
      expect(server.transactions[0].user).toBe('mailer');
    });

    it('authenticates with XOAUTH2, asking the token function on every new connection', async () => {
      let issued = 0;
      await boot(
        { users: { 'mailer@example.com': 'token-1', 'other@example.com': 'x' } },
        { auth: { user: 'mailer@example.com', accessToken: async () => `token-${++issued}` }, authMethod: 'XOAUTH2' },
      );

      await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' }).expect(201);
      expect(server.transactions[0].user).toBe('mailer@example.com');

      // The second connection gets token-2, which the server does not know: a permanent 535
      const { body } = await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' }).expect(422);
      expect(body).toMatchObject({ name: 'MailSmtpError', code: 535, command: 'AUTH', permanent: true });
      expect(issued).toBe(2);
      expect(server.transactions).toHaveLength(1);
    });

    it('speaks implicit TLS from an smtps:// URL, credentials percent-decoded', async () => {
      server = await new FakeSmtpServer({ implicitTls: true, users: { 'mailer@example.com': 'p@ss:w/rd' } }).listen();
      app = await createApp(name, appModule({
        transport: new SmtpTransport({
          url: `smtps://mailer%40example.com:p%40ss%3Aw%2Frd@127.0.0.1:${server.port}`,
          tls: { ca: server.certificate.cert },
        }),
        from: 'orders@example.com',
      }));

      await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' }).expect(201);

      expect(server.sessions[0].commands).not.toContain('STARTTLS');
      expect(server.transactions[0]).toMatchObject({ secure: true, user: 'mailer@example.com' });
    });

    it('refuses to send when STARTTLS is required and the server does not offer it: permanent, nothing sent', async () => {
      await boot({ startTls: false }, { startTls: 'required', auth: undefined });

      const { body } = await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' }).expect(422);

      expect(body).toMatchObject({ name: 'MailConnectionError', permanent: true });
      expect(server.sessions).toHaveLength(1);
      expect(server.sessions[0].commands.some((c) => c.startsWith('MAIL'))).toBe(false);
      expect(events).toEqual([expect.objectContaining({ type: 'failed', attempts: 1, permanent: true })]);
    });

    it('refuses a certificate it cannot verify, and retries that as a transient failure', async () => {
      await boot({}, { tls: {} });

      const { body } = await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' }).expect(503);

      expect(body).toMatchObject({ name: 'MailConnectionError', permanent: false });
      expect(server.transactions).toEqual([]);
      expect(server.sessions).toHaveLength(3);
      expect(events).toEqual([expect.objectContaining({ type: 'failed', attempts: 3, permanent: false })]);
    });

    it('answers a health check with verify(): connect, authenticate, QUIT, no transaction', async () => {
      await boot({});

      await http().get('/mail/health').expect(200, { ok: true });

      const commands = server.sessions[0].commands;
      expect(commands.some((c) => c.startsWith('AUTH PLAIN'))).toBe(true);
      expect(commands.at(-1)).toBe('QUIT');
      expect(server.transactions).toEqual([]);
    });
  });

  describe('what the receiving server gets', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'mail-integration-'));
      writeFileSync(join(dir, 'terms.txt'), 'Regulamin sklepu: zwroty do 14 dni.\n');
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('a mail class rendered into html and text alternatives, an inline image, attachments and encoded headers', async () => {
      await boot({});

      const { body: result } = await http()
        .post('/mail/orders')
        .send({
          to: { name: 'Zoë Łukasiewicz, PhD', address: 'zoe@example.com' },
          cc: ['Ada <ada@example.com>'],
          bcc: ['audit@example.com'],
          name: 'Zoë <admin>',
          terms: join(dir, 'terms.txt'),
        })
        .expect(201);

      const [transaction] = server.transactions;
      expect(transaction.to).toEqual(['zoe@example.com', 'ada@example.com', 'audit@example.com']);
      expect(result.accepted).toEqual(transaction.to);

      const raw = received(transaction);
      expect(lint(raw)).toEqual([]);
      expect(raw).not.toContain('audit@example.com');

      const message = parseMessage(raw);
      expect(decodeWords(header(message.headers, 'subject')!)).toBe('Zamówienie #1001: dziękujemy, Zoë <admin>!');
      expect(parseAddresses(header(message.headers, 'to')!)).toEqual([{ name: 'Zoë Łukasiewicz, PhD', address: 'zoe@example.com' }]);
      expect(parseAddresses(header(message.headers, 'cc')!)).toEqual([{ name: 'Ada', address: 'ada@example.com' }]);
      expect(parseAddresses(header(message.headers, 'from')!)).toEqual([{ name: 'Orders', address: 'orders@example.com' }]);
      expect(parseAddresses(header(message.headers, 'reply-to')!)).toEqual([{ name: 'Support', address: 'support@example.com' }]);
      expect(header(message.headers, 'message-id')).toBe(result.messageId);
      expect(header(message.headers, 'x-mailer-app')).toBe('cat-store');
      expect(header(message.headers, 'list-unsubscribe')).toBe('<https://shop.example.com/unsubscribe?u=1>');
      expect(headerAll(message.headers, 'bcc')).toEqual([]);

      expect(message.type).toBe('multipart/mixed');
      const [alternative, invoice, terms] = message.parts;
      expect(alternative.type).toBe('multipart/alternative');
      const [text, related] = alternative.parts;
      expect(text.type).toBe('text/plain');
      expect(text.body.toString()).toContain('Cześć Zoë <admin>,');
      expect(text.body.toString()).toContain('Zobacz zamówienie (https://shop.example.com/orders/1001?ref=mail&lang=pl)');

      expect(related.type).toBe('multipart/related');
      const [htmlPart, logo] = related.parts;
      expect(htmlPart.type).toBe('text/html');
      expect(htmlPart.params.charset).toBe('utf-8');
      expect(htmlPart.body.toString()).toContain('Cześć Zoë &lt;admin&gt;,');
      expect(htmlPart.body.toString()).toContain('href="https://shop.example.com/orders/1001?ref=mail&amp;lang=pl"');
      expect(header(logo.headers, 'content-id')).toBe('<logo@example.com>');
      expect(logo.type).toBe('image/png');
      expect(logo.body.equals(PNG)).toBe(true);

      expect(invoice.type).toBe('application/pdf');
      expect(parseContentType(header(invoice.headers, 'content-disposition')!)).toEqual(['attachment', { filename: 'faktura-żółw.pdf' }]);
      expect(header(invoice.headers, 'content-transfer-encoding')).toBe('base64');
      expect(invoice.body.equals(PDF)).toBe(true);

      expect(terms.type).toBe('text/plain');
      expect(parseContentType(header(terms.headers, 'content-disposition')!)[1].filename).toBe('terms.txt');
      expect(terms.body.toString()).toBe('Regulamin sklepu: zwroty do 14 dni.\n');
      expect(leaves(message)).toHaveLength(5);
      expect(app.get(OrderMail).contexts.at(-1)).toEqual({ locale: undefined, to: [{ name: 'Zoë Łukasiewicz, PhD', address: 'zoe@example.com' }] });
    });

    it('a body that looks like SMTP arrives intact, dot-stuffed on the wire, as one message', async () => {
      await boot({});
      const text = 'Line one\n.\nMAIL FROM:<evil@example.com>\r\n..two dots\rQUIT';

      await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Smuggling', text }).expect(201);

      expect(server.transactions).toHaveLength(1);
      expect(server.sessions[0].commands.filter((c) => c.startsWith('MAIL'))).toHaveLength(1);
      const body = parseMessage(received(server.transactions[0])).body.toString();
      expect(body.replace(/\r\n$/, '')).toBe('Line one\r\n.\r\nMAIL FROM:<evil@example.com>\r\n..two dots\r\nQUIT');
    });

    it('announces SMTPUTF8 for an internationalized mailbox, and converts its domain to ASCII', async () => {
      await boot({});

      await http().post('/mail/plain').send({ to: 'żaneta@bücher.example', subject: 'Cześć', text: 'Zażółć gęślą jaźń' }).expect(201);

      const [transaction] = server.transactions;
      expect(transaction.params).toEqual(expect.arrayContaining(['SMTPUTF8', 'BODY=8BITMIME']));
      expect(transaction.to).toEqual(['żaneta@xn--bcher-kva.example']);
      const message = parseMessage(received(transaction));
      expect(message.body.toString()).toBe('Zażółć gęślą jaźń\r\n');
    });

    it.each(['ed25519', 'rsa'] as const)('signs with DKIM (%s) so that the receiving side verifies the signature', async (type) => {
      const { privateKey, publicKey } = type === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ed25519');
      await boot({}, { dkim: { domainName: 'example.com', keySelector: 'mail2026', privateKey } });

      await http().post('/mail/orders').send({ to: 'zoe@example.com', name: 'Zoë' }).expect(201);

      const raw = received(server.transactions[0]);
      const { tags, bodyHash, signature } = verifyDkim(raw, publicKey);
      expect({ bodyHash, signature }).toEqual({ bodyHash: true, signature: true });
      expect(tags).toMatchObject({ v: '1', a: `${type}-sha256`, c: 'relaxed/relaxed', d: 'example.com', s: 'mail2026' });
      const signed = tags.h.toLowerCase().split(':');
      expect(signed.filter((h) => h === 'from')).toHaveLength(2);
      expect(signed).toEqual(expect.arrayContaining(['to', 'subject', 'date', 'message-id', 'reply-to', 'list-unsubscribe', 'x-mailer-app']));

      // A relay that adds a second From below the signature breaks it
      const forged = raw.replace('\r\n\r\n', '\r\nFrom: ceo@example.com\r\n\r\n');
      expect(verifyDkim(forged, publicKey).signature).toBe(false);
    });
  });

  describe('replies, retries and events', () => {
    it('retries a 4xx reply with the same Message-ID, and reports the attempts on the result and events$', async () => {
      const backoffs: [number, unknown][] = [];
      let mailFrom = 0;
      await boot(
        { reply: (command) => (command.startsWith('MAIL FROM') && ++mailFrom === 1 ? '451 4.7.1 Greylisted, try again later' : undefined) },
        {},
        { retry: { attempts: 3, backoff: (attempt, error) => (backoffs.push([attempt, error]), 0) } },
      );

      const { body } = await http().post('/mail/orders').send({ to: 'zoe@example.com', name: 'Zoë', idempotencyKey: 'order-1001' }).expect(201);

      expect(body.attempts).toBe(2);
      expect(backoffs).toEqual([[1, expect.objectContaining({ name: 'MailSmtpError', code: 451, enhancedCode: '4.7.1', command: 'MAIL FROM' })]]);
      expect(header(parseMessage(received(server.transactions[0])).headers, 'message-id')).toBe(body.messageId);
      expect(events).toEqual([
        expect.objectContaining({
          type: 'sent',
          messageId: body.messageId,
          mail: 'OrderMail',
          recipients: ['zoe@example.com'],
          subject: 'Zamówienie #1001: dziękujemy, Zoë!',
          transport: 'SmtpTransport',
          attempts: 2,
          durationMs: expect.any(Number),
        }),
      ]);
    });

    it('sends the same Message-ID again when the reply to the data was a 4xx, so the receiver can drop a duplicate', async () => {
      await boot({ dataReply: (transaction) => (transaction.data && server.transactions.length === 1 ? '452 4.3.1 Insufficient system storage' : '250 2.0.0 Ok') });

      const { body } = await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello', idempotencyKey: 'outbox-42' }).expect(201);

      expect(server.transactions).toHaveLength(2);
      const ids = server.transactions.map((t) => header(parseMessage(received(t)).headers, 'message-id'));
      expect(ids).toEqual([body.messageId, body.messageId]);
      expect(body.attempts).toBe(2);
    });

    it('stops at a 5xx reply after one attempt, and publishes failed on events$ and the diagnostics channel', async () => {
      await boot({ reply: (command) => (command.startsWith('MAIL FROM') ? '550 5.7.1 Sender blocked' : undefined) });
      const published: unknown[] = [];
      const onFailed = (message: unknown) => published.push(message);
      diagnostics.subscribe('nestjs:mail:failed', onFailed);

      try {
        const { body } = await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' }).expect(422);

        expect(body).toMatchObject({ name: 'MailSmtpError', code: 550, enhancedCode: '5.7.1', command: 'MAIL FROM', permanent: true });
        expect(server.sessions).toHaveLength(1);
        const failed = { type: 'failed', attempts: 1, permanent: true, transport: 'SmtpTransport', error: expect.objectContaining({ code: 550 }) };
        expect(events).toEqual([expect.objectContaining(failed)]);
        expect(published).toEqual([expect.objectContaining(failed)]);
      } finally {
        diagnostics.unsubscribe('nestjs:mail:failed', onFailed);
      }
    });

    it('sends to nobody when one recipient is refused, and names it', async () => {
      await boot({ reply: (command) => (command === 'RCPT TO:<gone@example.com>' ? '550 5.1.1 User unknown' : undefined) });

      const { body } = await http()
        .post('/mail/plain')
        .send({ to: ['ada@example.com', 'gone@example.com'], subject: 'Hi', text: 'Hello' })
        .expect(422);

      expect(body).toMatchObject({
        name: 'MailRecipientsRejectedError',
        rejected: [{ address: 'gone@example.com', code: 550, enhancedCode: '5.1.1', response: 'User unknown' }],
      });
      expect(server.transactions).toEqual([]);
      expect(server.sessions[0].commands).not.toContain('DATA');
    });

    it('publishes sent on the diagnostics channel with what the app can correlate', async () => {
      await boot({});
      const published: MailEvent[] = [];
      const onSent = (message: unknown) => published.push(message as MailEvent);
      diagnostics.subscribe('nestjs:mail:sent', onSent);

      try {
        const { body } = await http().post('/mail/orders').send({ to: 'zoe@example.com', name: 'Zoë' }).expect(201);
        expect(published).toEqual([expect.objectContaining({ type: 'sent', messageId: body.messageId, mail: 'OrderMail', attempts: 1 })]);
        expect(published[0]).not.toHaveProperty('providerMessageId');
      } finally {
        diagnostics.unsubscribe('nestjs:mail:sent', onSent);
      }
    });

    it('rejects an invalid message before connecting: no attempt, no event', async () => {
      await boot({});

      await http().post('/mail/plain').send({ to: 'a@x.com, b@y.com', subject: 'Hi', text: 'Hello' }).expect(422);
      await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Hi\r\nBcc: eve@example.com', text: 'x' }).expect(422);

      expect(server.sessions).toEqual([]);
      expect(events).toEqual([]);
    });
  });

  describe('pooling and shutdown', () => {
    it('shares at most maxConnections connections between concurrent requests, and says QUIT on every one on shutdown', async () => {
      await boot({}, { pool: { maxConnections: 2, maxMessages: 10 } });

      const sends = Array.from({ length: 6 }, (_, i) =>
        http().post('/mail/plain').send({ to: `user${i}@example.com`, subject: `Mail ${i}`, text: 'Hello' }).expect(201),
      );
      await Promise.all(sends);

      expect(server.transactions).toHaveLength(6);
      expect(server.sessions.length).toBeLessThanOrEqual(2);

      await app.close();
      for (const session of server.sessions) {
        expect(session.commands.at(-1)).toBe('QUIT');
      }
      expect(eventsCompleted).toBe(true);
    });

    it('moves a send to a new connection when the server dropped the pooled one while idle', async () => {
      await boot({}, { pool: { maxConnections: 1 } });

      await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'One', text: 'x' }).expect(201);
      server.dropConnections();
      await settle();
      const { body } = await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Two', text: 'x' }).expect(201);

      expect(body.attempts).toBe(1);
      expect(server.transactions.map((t) => decodeWords(header(parseMessage(received(t)).headers, 'subject')!))).toEqual(['One', 'Two']);
      expect(server.sessions).toHaveLength(2);
    });

    it('waits on shutdown for a send still in flight, then quits the connection and completes events$', async () => {
      let releaseReply: (() => void) | undefined;
      await boot(
        {
          startTls: false,
          dataReply: () => {
            const socket = server.sessions[0].socket;
            releaseReply = () => socket.write('250 2.0.0 Ok: queued late\r\n');
            return '';
          },
        },
        { auth: undefined, pool: true },
      );

      await http().post('/mail/background').send({ to: 'ada@example.com', subject: 'Late', text: 'x' }).expect(202);
      await vi.waitFor(() => expect(releaseReply).toBeDefined());

      let closed = false;
      const closing = app.close().then(() => (closed = true));
      await settle(20);
      expect(closed).toBe(false);
      expect(eventsCompleted).toBe(false);

      releaseReply!();
      await closing;

      const [result] = await Promise.all(app.get(Background).sends);
      expect(result).toMatchObject({ attempts: 1, response: expect.stringContaining('queued late') });
      expect(events.map((e) => e.type)).toEqual(['sent']);
      expect(eventsCompleted).toBe(true);
      expect(server.sessions[0].commands.at(-1)).toBe('QUIT');
    });
  });
});
