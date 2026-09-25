import { Body, Controller, HttpException, Injectable, Module, Post, type INestApplication } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import {
  html,
  MailError,
  MailEvents,
  Mailer,
  MailModule,
  MailTransport,
  PostmarkTransport,
  ResendTransport,
  SendGridTransport,
  SesTransport,
  type Mailable,
  type MailEvent,
  type MailSendOptions,
  type MailSendResult,
} from '../lib/index.js';
import { HttpProviderStub, type RecordedRequest } from './support/integration.js';
import { decodeWords, header, headerAll, parseAddresses, parseContentType, parseMessage } from './support/mime-parser.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const PDF = Buffer.from('%PDF-1.7 \x00\xff', 'latin1');
const HTML = '<p>Dziękujemy</p><img src="cid:logo">';
const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'session-1' };

@Injectable()
class ReceiptMail implements Mailable<{ number: number }> {
  render({ number }: { number: number }) {
    return {
      subject: `Zamówienie #${number}`,
      html: html`<p>Dziękujemy</p><img src="cid:logo">`,
      text: 'Dziękujemy',
      attachments: [
        { cid: 'logo', filename: 'logo.png', content: PNG },
        { filename: `faktura-${number}.pdf`, content: PDF },
      ],
    };
  }
}

async function answer(send: Promise<MailSendResult>): Promise<MailSendResult> {
  try {
    return await send;
  } catch (error) {
    if (!(error instanceof MailError)) {
      throw error;
    }
    const extra = error as unknown as Record<string, unknown>;
    throw new HttpException(
      { name: error.name, permanent: error.permanent, code: error.code, provider: extra.provider, providerCode: extra.providerCode, phase: extra.phase, message: error.message },
      error.permanent ? 422 : 503,
    );
  }
}

@Controller('mail')
class MailController {
  constructor(private readonly mailer: Mailer) {}

  @Post('receipts')
  receipt(@Body() body: { idempotencyKey?: string }) {
    return answer(
      this.mailer.send(ReceiptMail, {
        to: { name: 'Zoë Łukasiewicz', address: 'zoe@example.com' },
        cc: 'ada@example.com',
        bcc: 'audit@example.com',
        data: { number: 42 },
        headers: { 'X-Order': '42' },
        idempotencyKey: body.idempotencyKey,
      }),
    );
  }

  @Post('plain')
  plain(@Body() body: MailSendOptions) {
    return answer(this.mailer.send(body));
  }
}

const PROVIDER_SETTINGS = Symbol('PROVIDER_SETTINGS');

interface ProviderSettings {
  baseUrl: string;
}

/** An app configuring its provider from injected settings, as `forRootAsync()` with a config service does. */
function appModule(transport: (settings: ProviderSettings) => MailTransport, settings: ProviderSettings) {
  @Module({ providers: [{ provide: PROVIDER_SETTINGS, useValue: settings }], exports: [PROVIDER_SETTINGS] })
  class SettingsModule {}

  @Module({
    imports: [
      MailModule.forRootAsync({
        imports: [SettingsModule],
        inject: [PROVIDER_SETTINGS],
        useFactory: (injected: ProviderSettings) => ({
          transport: transport(injected),
          from: 'Orders <orders@example.com>',
          replyTo: 'Support <support@example.com>',
          retry: { attempts: 3, backoff: { delay: 0, jitter: 'none' } },
        }),
      }),
    ],
    controllers: [MailController],
    providers: [ReceiptMail],
  })
  class AppModule {}
  return AppModule;
}

/** Signature Version 4 recomputed from the request the server received, as AWS does. */
function expectedSigV4(req: RecordedRequest, region: string, secret: string): { authorization: string } {
  const authorization = String(req.headers.authorization);
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)![1].split(';');
  const amzDate = String(req.headers['x-amz-date']);
  const day = amzDate.slice(0, 8);

  const canonical = [
    req.method,
    req.path,
    '',
    ...signedHeaders.map((name) => `${name}:${String(req.headers[name]).trim()}`),
    '',
    signedHeaders.join(';'),
    createHash('sha256').update(req.raw).digest('hex'),
  ].join('\n');
  const scope = `${day}/${region}/ses/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const key = [day, region, 'ses', 'aws4_request'].reduce<Buffer | string>((k, part) => createHmac('sha256', k).update(part).digest(), `AWS4${secret}`);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');

  return { authorization: `AWS4-HMAC-SHA256 Credential=${CREDENTIALS.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}` };
}

describe.each(adapters)('sending through the HTTP providers from an app ($name)', ({ name }) => {
  let stub: HttpProviderStub;
  let app: INestApplication;
  let events: MailEvent[];

  async function boot(transport: (settings: ProviderSettings) => MailTransport) {
    app = await createApp(name, appModule(transport, { baseUrl: stub.baseUrl }), { setup: (app) => app.useLogger(false) });
    events = [];
    app.get(MailEvents).events$.subscribe((event) => events.push(event));
  }

  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    stub = await new HttpProviderStub().listen();
  });
  afterEach(async () => {
    await app?.close();
    await stub.close();
  });

  describe('Resend', () => {
    const resend = ({ baseUrl }: ProviderSettings) => new ResendTransport({ apiKey: 're_test_123', baseUrl });

    it('posts the message to /emails with the API key and the idempotency key, and returns Resend’s id', async () => {
      stub.reply = () => ({ status: 200, body: { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' } });
      await boot(resend);

      const { body } = await http().post('/mail/receipts').send({ idempotencyKey: 'outbox-0193' }).expect(201);

      expect(body).toMatchObject({
        providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794',
        accepted: ['zoe@example.com', 'ada@example.com', 'audit@example.com'],
        attempts: 1,
      });
      const [req] = stub.requests;
      expect(req).toMatchObject({ method: 'POST', path: '/emails' });
      expect(req.headers).toMatchObject({
        authorization: 'Bearer re_test_123',
        'content-type': 'application/json',
        'idempotency-key': 'outbox-0193',
        'user-agent': 'nestjs-mail',
      });
      expect(req.json).toEqual({
        from: 'Orders <orders@example.com>',
        to: ['Zoë Łukasiewicz <zoe@example.com>'],
        cc: ['ada@example.com'],
        bcc: ['audit@example.com'],
        reply_to: ['Support <support@example.com>'],
        subject: 'Zamówienie #42',
        html: HTML,
        text: 'Dziękujemy',
        headers: { 'X-Order': '42' },
        attachments: [
          { filename: 'logo.png', content: PNG.toString('base64'), content_type: 'image/png', content_id: 'logo' },
          { filename: 'faktura-42.pdf', content: PDF.toString('base64'), content_type: 'application/pdf' },
        ],
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'sent', transport: 'ResendTransport', mail: 'ReceiptMail', providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }),
      ]);
    });

    it('fails a validation_error at once, as permanent, naming Resend’s error', async () => {
      stub.reply = () => ({ status: 422, body: { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' } });
      await boot(resend);

      const { body } = await http().post('/mail/receipts').send({}).expect(422);

      expect(body).toMatchObject({ name: 'MailProviderError', provider: 'resend', code: 422, providerCode: 'validation_error', permanent: true });
      expect(body.message).toContain('Invalid `to` field.');
      expect(body.message).not.toContain('re_test_123');
      expect(stub.requests).toHaveLength(1);
      expect(events).toEqual([expect.objectContaining({ type: 'failed', attempts: 1, permanent: true })]);
    });

    it('retries a concurrent request with the same key (409) with the same key, and succeeds', async () => {
      stub.reply = (_req, i) =>
        i === 0 ? { status: 409, body: { name: 'concurrent_idempotent_requests', message: 'Same key in flight' } } : { status: 200, body: { id: 'r-2' } };
      await boot(resend);

      const { body } = await http().post('/mail/receipts').send({ idempotencyKey: 'outbox-7' }).expect(201);

      expect(body).toMatchObject({ providerMessageId: 'r-2', attempts: 2 });
      expect(stub.requests.map((r) => r.headers['idempotency-key'])).toEqual(['outbox-7', 'outbox-7']);
      expect(stub.requests[1].raw).toBe(stub.requests[0].raw);
    });

    it('does not retry the same key with a different body (409 invalid_idempotent_request)', async () => {
      stub.reply = () => ({ status: 409, body: { name: 'invalid_idempotent_request', message: 'Different payload' } });
      await boot(resend);

      await http().post('/mail/receipts').send({ idempotencyKey: 'outbox-7' }).expect(422);
      expect(stub.requests).toHaveLength(1);
    });

    it('retries rate limits (429) and server errors (500) until the attempts run out', async () => {
      stub.reply = (_req, i) =>
        i === 0 ? { status: 429, body: { name: 'rate_limit_exceeded', message: 'Too many requests' } } : { status: 500, body: { name: 'internal_server_error' } };
      await boot(resend);

      const { body } = await http().post('/mail/receipts').send({}).expect(503);

      expect(body).toMatchObject({ provider: 'resend', code: 500, permanent: false });
      expect(stub.requests).toHaveLength(3);
      expect(events).toEqual([expect.objectContaining({ type: 'failed', attempts: 3, permanent: false })]);
    });

    it('needs a to before any request: a cc alone is refused as the caller’s mistake', async () => {
      await boot(resend);

      await http().post('/mail/plain').send({ cc: 'ada@example.com', subject: 'Hi', text: 'x' }).expect(422);
      expect(stub.requests).toEqual([]);
    });
  });

  describe('Postmark', () => {
    const postmark = ({ baseUrl }: ProviderSettings) => new PostmarkTransport({ serverToken: 'pm-server-token', messageStream: 'receipts', baseUrl });

    it('posts PascalCase fields to /email with the server token, on the configured stream', async () => {
      stub.reply = () => ({ status: 200, body: { ErrorCode: 0, Message: 'OK', MessageID: 'b7bc2f4a-e38e-4336-af7d-e6c392c2f817', To: 'zoe@example.com' } });
      await boot(postmark);

      const { body } = await http().post('/mail/receipts').send({ idempotencyKey: 'ignored-by-postmark' }).expect(201);

      expect(body.providerMessageId).toBe('b7bc2f4a-e38e-4336-af7d-e6c392c2f817');
      const [req] = stub.requests;
      expect(req).toMatchObject({ method: 'POST', path: '/email' });
      expect(req.headers).toMatchObject({ 'x-postmark-server-token': 'pm-server-token', accept: 'application/json', 'content-type': 'application/json' });
      expect(req.headers).not.toHaveProperty('idempotency-key');
      expect(req.json).toEqual({
        From: 'Orders <orders@example.com>',
        To: 'Zoë Łukasiewicz <zoe@example.com>',
        Cc: 'ada@example.com',
        Bcc: 'audit@example.com',
        ReplyTo: 'Support <support@example.com>',
        Subject: 'Zamówienie #42',
        HtmlBody: HTML,
        TextBody: 'Dziękujemy',
        Headers: [{ Name: 'X-Order', Value: '42' }],
        Attachments: [
          { Name: 'logo.png', Content: PNG.toString('base64'), ContentType: 'image/png', ContentID: 'cid:logo' },
          { Name: 'faktura-42.pdf', Content: PDF.toString('base64'), ContentType: 'application/pdf' },
        ],
        MessageStream: 'receipts',
      });
    });

    it('maps Postmark’s ErrorCode: a 422 inactive recipient is permanent', async () => {
      stub.reply = () => ({ status: 422, body: { ErrorCode: 406, Message: 'You tried to send to a recipient that has been marked as inactive.' } });
      await boot(postmark);

      const { body } = await http().post('/mail/receipts').send({}).expect(422);

      expect(body).toMatchObject({ provider: 'postmark', code: 422, providerCode: '406', permanent: true });
      expect(body.message).toContain('marked as inactive');
      expect(stub.requests).toHaveLength(1);
    });

    it('retries a 500 and succeeds on the next attempt', async () => {
      stub.reply = (_req, i) => (i === 0 ? { status: 500, body: 'Internal Server Error' } : { status: 200, body: { MessageID: 'pm-2' } });
      await boot(postmark);

      const { body } = await http().post('/mail/receipts').send({}).expect(201);
      expect(body).toMatchObject({ providerMessageId: 'pm-2', attempts: 2 });
    });
  });

  describe('SendGrid', () => {
    const sendgrid = ({ baseUrl }: ProviderSettings) => new SendGridTransport({ apiKey: 'SG.test-key', baseUrl });

    it('posts one personalization to /v3/mail/send, text before html, and reads X-Message-Id from a 202', async () => {
      stub.reply = () => ({ status: 202, headers: { 'x-message-id': 'sg-W1n5dPiURbC2' }, body: '' });
      await boot(sendgrid);

      const { body } = await http().post('/mail/receipts').send({}).expect(201);

      expect(body.providerMessageId).toBe('sg-W1n5dPiURbC2');
      const [req] = stub.requests;
      expect(req).toMatchObject({ method: 'POST', path: '/v3/mail/send' });
      expect(req.headers).toMatchObject({ authorization: 'Bearer SG.test-key', 'content-type': 'application/json' });
      expect(req.json).toEqual({
        personalizations: [
          {
            to: [{ email: 'zoe@example.com', name: 'Zoë Łukasiewicz' }],
            cc: [{ email: 'ada@example.com' }],
            bcc: [{ email: 'audit@example.com' }],
          },
        ],
        from: { email: 'orders@example.com', name: 'Orders' },
        reply_to_list: [{ email: 'support@example.com', name: 'Support' }],
        subject: 'Zamówienie #42',
        content: [
          { type: 'text/plain', value: 'Dziękujemy' },
          { type: 'text/html', value: HTML },
        ],
        headers: { 'X-Order': '42' },
        attachments: [
          { content: PNG.toString('base64'), filename: 'logo.png', type: 'image/png', disposition: 'inline', content_id: 'logo' },
          { content: PDF.toString('base64'), filename: 'faktura-42.pdf', type: 'application/pdf', disposition: 'attachment' },
        ],
      });
      expect(events).toEqual([expect.objectContaining({ type: 'sent', transport: 'SendGridTransport', providerMessageId: 'sg-W1n5dPiURbC2' })]);
    });

    it('joins SendGrid’s errors, with their fields, into a permanent error for a 400', async () => {
      stub.reply = () => ({
        status: 400,
        body: { errors: [{ message: 'The from address does not match a verified Sender Identity.', field: 'from', help: null }, { message: 'Bad request', field: null }] },
      });
      await boot(sendgrid);

      const { body } = await http().post('/mail/receipts').send({}).expect(422);

      expect(body).toMatchObject({ provider: 'sendgrid', code: 400, permanent: true });
      expect(body.message).toContain('from: The from address does not match a verified Sender Identity.; Bad request');
      expect(body.message).not.toContain('SG.test-key');
    });

    it('retries a 429', async () => {
      stub.reply = (_req, i) => (i < 2 ? { status: 429, body: { errors: [{ message: 'too many requests' }] } } : { status: 202, body: '' });
      await boot(sendgrid);

      const { body } = await http().post('/mail/receipts').send({}).expect(201);
      expect(body.attempts).toBe(3);
      expect(body).not.toHaveProperty('providerMessageId');
    });
  });

  describe('Amazon SES', () => {
    const ses = ({ baseUrl }: ProviderSettings) =>
      new SesTransport({ region: 'eu-central-1', endpoint: baseUrl, credentials: async () => CREDENTIALS, configurationSetName: 'transactional' });

    it('posts the raw MIME message, Bcc in Destination only, signed with SigV4 the server can verify', async () => {
      stub.reply = () => ({ status: 200, body: { MessageId: '0107018f-ses-message-id' } });
      await boot(ses);

      const { body } = await http().post('/mail/receipts').send({}).expect(201);

      expect(body.providerMessageId).toBe('0107018f-ses-message-id');
      const [req] = stub.requests;
      expect(req).toMatchObject({ method: 'POST', path: '/v2/email/outbound-emails' });
      expect(req.headers.host).toBe(new URL(stub.baseUrl).host);
      expect(req.headers['x-amz-security-token']).toBe('session-1');
      expect(req.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, /);
      expect(req.headers.authorization).toBe(expectedSigV4(req, 'eu-central-1', CREDENTIALS.secretAccessKey).authorization);

      expect(req.json).toEqual({
        FromEmailAddress: 'orders@example.com',
        Destination: { ToAddresses: ['zoe@example.com'], CcAddresses: ['ada@example.com'], BccAddresses: ['audit@example.com'] },
        Content: { Raw: { Data: expect.any(String) } },
        ConfigurationSetName: 'transactional',
      });

      const mime = Buffer.from(req.json.Content.Raw.Data, 'base64').toString('utf8');
      const message = parseMessage(mime);
      expect(headerAll(message.headers, 'bcc')).toEqual([]);
      expect(mime).not.toContain('audit@example.com');
      expect(decodeWords(header(message.headers, 'subject')!)).toBe('Zamówienie #42');
      expect(parseAddresses(header(message.headers, 'to')!)).toEqual([{ name: 'Zoë Łukasiewicz', address: 'zoe@example.com' }]);
      expect(header(message.headers, 'message-id')).toBe(body.messageId);
      const [alternative, invoice] = message.parts;
      expect(alternative.parts[1].parts.map((p) => p.type)).toEqual(['text/html', 'image/png']);
      expect(parseContentType(header(invoice.headers, 'content-disposition')!)[1].filename).toBe('faktura-42.pdf');
      expect(invoice.body.equals(PDF)).toBe(true);
    });

    it('fails a MessageRejected permanently, reading the type from x-amzn-ErrorType', async () => {
      stub.reply = () => ({
        status: 400,
        headers: { 'x-amzn-errortype': 'MessageRejected:http://internal.amazon.com/coral/com.amazonaws.sesv2/' },
        body: { message: 'Email address is not verified. The following identities failed the check: orders@example.com' },
      });
      await boot(ses);

      const { body } = await http().post('/mail/receipts').send({}).expect(422);

      expect(body).toMatchObject({ provider: 'ses', code: 400, providerCode: 'MessageRejected', permanent: true });
      expect(body.message).not.toContain(CREDENTIALS.secretAccessKey);
      expect(stub.requests).toHaveLength(1);
    });

    it('retries throttling, even as a 400 with the type in the body, and signs every attempt afresh', async () => {
      stub.reply = (_req, i) =>
        i === 0 ? { status: 400, body: { __type: 'com.amazon.coral.availability#ThrottlingException', message: 'Rate exceeded' } } : { status: 200, body: { MessageId: 'ses-2' } };
      await boot(ses);

      const { body } = await http().post('/mail/receipts').send({}).expect(201);

      expect(body).toMatchObject({ providerMessageId: 'ses-2', attempts: 2 });
      for (const req of stub.requests) {
        expect(req.headers.authorization).toBe(expectedSigV4(req, 'eu-central-1', CREDENTIALS.secretAccessKey).authorization);
      }
    });
  });

  describe('every provider', () => {
    it('refuses a redirect instead of following it with the API key, as a transient connection error', async () => {
      stub.reply = () => ({ status: 307, headers: { location: 'https://attacker.example/emails' }, body: '' });
      await boot(({ baseUrl }) => new ResendTransport({ apiKey: 're_test_123', baseUrl }));

      const { body } = await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Hi', text: 'x', retry: false }).expect(503);

      expect(body).toMatchObject({ name: 'MailConnectionError', permanent: false });
      expect(stub.requests).toHaveLength(1);
    });

    it('times out a request the provider never answers, per the transport’s timeout', async () => {
      stub.reply = () => 'hang';
      await boot(({ baseUrl }) => new PostmarkTransport({ serverToken: 'pm-server-token', baseUrl, timeout: '100ms' }));

      const { body } = await http().post('/mail/plain').send({ to: 'ada@example.com', subject: 'Hi', text: 'x', retry: false }).expect(503);

      expect(body).toMatchObject({ name: 'MailTimeoutError', phase: 'request', permanent: false });
      expect(events).toEqual([expect.objectContaining({ type: 'failed', attempts: 1, permanent: false })]);
    });
  });
});
