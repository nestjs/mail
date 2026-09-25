import { createHash, createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import {
  MailConnectionError,
  MailMessageError,
  MailProviderError,
  MailTimeoutError,
  PostmarkTransport,
  ResendTransport,
  SendGridTransport,
  SesTransport,
} from '../lib/index.js';
import type { MailMessage } from '../lib/message/mail-message.js';
import { createMailMessage } from '../lib/message/normalize.util.js';
import { parseMessage } from './support/mime-parser.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  raw: string;
}

/** A fetch stub that records requests and answers with `respond`. */
function stubFetch(respond: (request: Captured) => Response | Promise<Response>) {
  const requests: Captured[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const raw = String(init.body);
    const request = {
      url,
      method: String(init.method),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: JSON.parse(raw),
      raw,
    };

    requests.push(request);
    init.signal?.throwIfAborted();
    return respond(request);
  }) as typeof globalThis.fetch;

  return { fetch, requests };
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
let message: MailMessage;
const send = { signal: new AbortController().signal, attempt: 1 };

beforeAll(async () => {
  message = await createMailMessage(
    {
      to: [{ name: 'Zoë, Ł.', address: 'zoe@example.com' }, 'ada@example.com'],
      cc: 'cc@example.com',
      bcc: 'audit@example.com',
      replyTo: 'Support <support@example.com>',
      subject: 'Zamówienie #42',
      html: '<p>Dziękujemy</p><img src="cid:logo">',
      attachments: [
        { cid: 'logo', filename: 'logo.png', content: png },
        { filename: 'invoice-42.pdf', content: Buffer.from('%PDF') },
      ],
      headers: { 'X-Order': '42' },
    },
    { from: 'Orders <orders@example.com>' },
  );
});

describe('ResendTransport', () => {
  it('posts the message with the idempotency key', async () => {
    const { fetch, requests } = stubFetch(() => Response.json({ id: '49a3999c' }));
    const transport = new ResendTransport({ apiKey: 're_test', fetch });
    const result = await transport.send(message, { ...send, idempotencyKey: 'outbox:0193' });

    expect(result).toEqual({ accepted: ['zoe@example.com', 'ada@example.com', 'cc@example.com', 'audit@example.com'], providerMessageId: '49a3999c' });

    const [request] = requests;
    expect(request.url).toBe('https://api.resend.com/emails');
    expect(request.method).toBe('POST');
    expect(request.headers).toMatchObject({
      authorization: 'Bearer re_test',
      'content-type': 'application/json',
      'idempotency-key': 'outbox:0193',
      'user-agent': 'nestjs-mail',
    });
    expect(request.body).toEqual({
      from: 'Orders <orders@example.com>',
      to: ['"Zoë, Ł." <zoe@example.com>', 'ada@example.com'],
      cc: ['cc@example.com'],
      bcc: ['audit@example.com'],
      reply_to: ['Support <support@example.com>'],
      subject: 'Zamówienie #42',
      html: '<p>Dziękujemy</p><img src="cid:logo">',
      text: 'Dziękujemy',
      headers: { 'X-Order': '42' },
      attachments: [
        { filename: 'logo.png', content: png.toString('base64'), content_type: 'image/png', content_id: 'logo' },
        { filename: 'invoice-42.pdf', content: Buffer.from('%PDF').toString('base64'), content_type: 'application/pdf' },
      ],
    });
  });

  it('needs a to, as Resend does, before any request', async () => {
    const { fetch, requests } = stubFetch(() => Response.json({ id: 'x' }));
    const bccOnly = await createMailMessage({ bcc: 'a@example.com', subject: 's', text: 'x' }, { from: 'a@example.com' });
    await expect(new ResendTransport({ apiKey: 're_test', fetch }).send(bccOnly, send)).rejects.toThrow(MailMessageError);
    expect(requests).toEqual([]);
  });

  it('hashes an idempotency key longer than Resend accepts', async () => {
    const { fetch, requests } = stubFetch(() => Response.json({ id: 'x' }));
    await new ResendTransport({ apiKey: 're_test', fetch }).send(message, { ...send, idempotencyKey: 'k'.repeat(300) });
    expect(requests[0].headers['idempotency-key']).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [422, 'validation_error', true],
    [403, 'validation_error', true],
    [429, 'rate_limit_exceeded', false],
    [409, 'concurrent_idempotent_requests', false],
    [409, 'invalid_idempotent_request', true],
    [500, 'application_error', false],
  ])('maps %i %s to permanent=%s', async (status, name, permanent) => {
    const { fetch } = stubFetch(() => Response.json({ statusCode: status, name, message: 'The example.com domain is not verified.' }, { status }));
    const error = await new ResendTransport({ apiKey: 're_secret_key', fetch }).send(message, send).catch((e) => e);

    expect(error).toBeInstanceOf(MailProviderError);
    expect(error).toMatchObject({ provider: 'resend', code: status, providerCode: name, permanent });
    expect(error.message).toBe(`resend refused the message with ${status} ${name}: The example.com domain is not verified.`);
    expect(error.message).not.toContain('re_secret_key');
  });
});

describe('PostmarkTransport', () => {
  it('posts PascalCase fields, comma-separated recipients and cid: content ids', async () => {
    const { fetch, requests } = stubFetch(() =>
      Response.json({ To: 'zoe@example.com', MessageID: '0a129aee', ErrorCode: 0, Message: 'OK' }),
    );
    const result = await new PostmarkTransport({ serverToken: 'pm-token', fetch }).send(message, send);

    expect(result.providerMessageId).toBe('0a129aee');

    const [request] = requests;
    expect(request.url).toBe('https://api.postmarkapp.com/email');
    expect(request.headers).toMatchObject({ accept: 'application/json', 'x-postmark-server-token': 'pm-token' });
    expect(request.body).toEqual({
      From: 'Orders <orders@example.com>',
      To: '"Zoë, Ł." <zoe@example.com>, ada@example.com',
      Cc: 'cc@example.com',
      Bcc: 'audit@example.com',
      ReplyTo: 'Support <support@example.com>',
      Subject: 'Zamówienie #42',
      HtmlBody: '<p>Dziękujemy</p><img src="cid:logo">',
      TextBody: 'Dziękujemy',
      Headers: [{ Name: 'X-Order', Value: '42' }],
      Attachments: [
        { Name: 'logo.png', Content: png.toString('base64'), ContentType: 'image/png', ContentID: 'cid:logo' },
        { Name: 'invoice-42.pdf', Content: Buffer.from('%PDF').toString('base64'), ContentType: 'application/pdf' },
      ],
      MessageStream: 'outbound',
    });
  });

  it('leaves out an empty TextBody (an HTML mail of images only)', async () => {
    const { fetch, requests } = stubFetch(() => Response.json({ MessageID: 'm' }));
    const imagesOnly = await createMailMessage({ to: 'a@example.com', subject: 's', html: '<img src="cid:x">', attachments: [{ cid: 'x', content: png }] }, { from: 'a@example.com' });
    expect(imagesOnly.text).toBe('');

    await new PostmarkTransport({ serverToken: 't', fetch }).send(imagesOnly, send);
    expect(requests[0].body).not.toHaveProperty('TextBody');
    expect(requests[0].body.HtmlBody).toBe('<img src="cid:x">');
  });

  it('reports Postmark error codes; 422 is permanent, 500 transient', async () => {
    const { fetch } = stubFetch(({ body }) =>
      body.Subject === 'boom'
        ? Response.json({ ErrorCode: 101, Message: 'Internal' }, { status: 500 })
        : Response.json({ ErrorCode: 406, Message: 'You tried to send to recipient(s) that have been marked as inactive.' }, { status: 422 }),
    );
    const transport = new PostmarkTransport({ serverToken: 't', fetch });

    await expect(transport.send(message, send)).rejects.toMatchObject({ code: 422, providerCode: '406', permanent: true });

    const boom = await createMailMessage({ to: 'a@example.com', subject: 'boom', text: 'x' }, { from: 'a@example.com' });
    await expect(transport.send(boom, send)).rejects.toMatchObject({ code: 500, providerCode: '101', permanent: false });
  });
});

describe('SendGridTransport', () => {
  it('posts one personalization, text before html, and reads X-Message-Id', async () => {
    const { fetch, requests } = stubFetch(() => new Response(null, { status: 202, headers: { 'x-message-id': 'sg-1' } }));
    const result = await new SendGridTransport({ apiKey: 'SG.key', fetch }).send(message, send);

    expect(result.providerMessageId).toBe('sg-1');

    const [request] = requests;
    expect(request.url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(request.headers.authorization).toBe('Bearer SG.key');
    expect(request.body).toEqual({
      personalizations: [
        {
          to: [{ email: 'zoe@example.com', name: 'Zoë, Ł.' }, { email: 'ada@example.com' }],
          cc: [{ email: 'cc@example.com' }],
          bcc: [{ email: 'audit@example.com' }],
        },
      ],
      from: { email: 'orders@example.com', name: 'Orders' },
      reply_to_list: [{ email: 'support@example.com', name: 'Support' }],
      subject: 'Zamówienie #42',
      content: [
        { type: 'text/plain', value: 'Dziękujemy' },
        { type: 'text/html', value: '<p>Dziękujemy</p><img src="cid:logo">' },
      ],
      headers: { 'X-Order': '42' },
      attachments: [
        { content: png.toString('base64'), filename: 'logo.png', type: 'image/png', disposition: 'inline', content_id: 'logo' },
        { content: Buffer.from('%PDF').toString('base64'), filename: 'invoice-42.pdf', type: 'application/pdf', disposition: 'attachment' },
      ],
    });
  });

  it('joins SendGrid errors into the message, and needs a to', async () => {
    const { fetch } = stubFetch(() =>
      Response.json({ errors: [{ message: 'The from address does not match a verified Sender Identity.', field: 'from' }] }, { status: 403 }),
    );
    await expect(new SendGridTransport({ apiKey: 'k', fetch }).send(message, send)).rejects.toThrow(
      'sendgrid refused the message with 403: from: The from address does not match a verified Sender Identity.',
    );

    const bccOnly = await createMailMessage({ bcc: 'a@example.com', subject: 's', text: 't' }, { from: 'a@example.com' });
    await expect(new SendGridTransport({ apiKey: 'k', fetch }).send(bccOnly, send)).rejects.toThrow(MailMessageError);
  });
});

describe('SesTransport', () => {
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'token-1' };

  it('sends the raw MIME message, signed with SigV4 for the ses service', async () => {
    const { fetch, requests } = stubFetch(() => Response.json({ MessageId: '0100018f-ses' }));
    const transport = new SesTransport({ region: 'eu-west-1', credentials, configurationSetName: 'transactional', fetch });
    const result = await transport.send(message, send);
    expect(result.providerMessageId).toBe('0100018f-ses');

    const [request] = requests;
    expect(request.url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails');
    expect(request.body).toMatchObject({
      FromEmailAddress: 'orders@example.com',
      Destination: { ToAddresses: ['zoe@example.com', 'ada@example.com'], CcAddresses: ['cc@example.com'], BccAddresses: ['audit@example.com'] },
      ConfigurationSetName: 'transactional',
    });

    const mime = Buffer.from(request.body.Content.Raw.Data, 'base64').toString('utf8');
    expect(parseMessage(mime).type).toBe('multipart/mixed');
    expect(mime).not.toContain('audit@example.com'); // Bcc only in the envelope

    // Recompute the signature from the request as sent: a second, plain implementation
    const amzDate = request.headers['x-amz-date'];
    expect(amzDate).toMatch(/^\d{8}T\d{6}Z$/);
    expect(request.headers['x-amz-security-token']).toBe('token-1');

    const canonical = [
      'POST',
      '/v2/email/outbound-emails',
      '',
      'content-type:application/json',
      'host:email.eu-west-1.amazonaws.com',
      `x-amz-date:${amzDate}`,
      'x-amz-security-token:token-1',
      '',
      'content-type;host;x-amz-date;x-amz-security-token',
      createHash('sha256').update(request.raw).digest('hex'),
    ].join('\n');
    const scope = `${amzDate.slice(0, 8)}/eu-west-1/ses/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
    const key = [amzDate.slice(0, 8), 'eu-west-1', 'ses', 'aws4_request'].reduce<Buffer | string>(
      (k, part) => createHmac('sha256', k).update(part).digest(),
      `AWS4${credentials.secretAccessKey}`,
    );
    const signature = createHmac('sha256', key).update(toSign).digest('hex');
    expect(request.headers.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/${scope}, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=${signature}`,
    );
  });

  it('resolves credentials from a function on every send', async () => {
    const { fetch, requests } = stubFetch(() => Response.json({ MessageId: 'x' }));
    let calls = 0;
    const transport = new SesTransport({ region: 'us-east-1', fetch, credentials: async () => ({ ...credentials, accessKeyId: `AKID${++calls}` }) });
    await transport.send(message, send);
    await transport.send(message, send);
    expect(requests.map((r) => r.headers.authorization.match(/Credential=(\w+)\//)![1])).toEqual(['AKID1', 'AKID2']);
  });

  it.each([
    ['MessageRejected', 400, true],
    ['MailFromDomainNotVerifiedException', 400, true],
    ['TooManyRequestsException', 429, false],
    ['LimitExceededException', 400, false],
    ['ThrottlingException', 400, false],
    ['InternalFailure', 500, false],
  ])('maps %s (%i) to permanent=%s', async (type, status, permanent) => {
    const { fetch } = stubFetch(
      () => new Response(JSON.stringify({ message: 'Email address is not verified.' }), { status, headers: { 'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazon.coral.service/` } }),
    );
    const error = await new SesTransport({ region: 'us-east-1', credentials, fetch }).send(message, send).catch((e) => e);
    expect(error).toMatchObject({ provider: 'ses', code: status, providerCode: type, permanent });
    expect(error.message).not.toContain(credentials.secretAccessKey);
  });

  it('fails at startup without a region or credentials', () => {
    const env = { ...process.env };
    try {
      delete process.env.AWS_REGION;
      delete process.env.AWS_DEFAULT_REGION;
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;

      expect(() => new SesTransport({ credentials })).toThrow(/`region` is required/);
      expect(() => new SesTransport({ region: 'eu-west-1' })).toThrow(/needs `credentials`/);

      process.env.AWS_ACCESS_KEY_ID = 'AKID';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';
      expect(() => new SesTransport({ region: 'eu-west-1' })).not.toThrow();
    } finally {
      process.env = env;
    }
  });
});

describe('every HTTP provider', () => {
  const transports = (fetch: typeof globalThis.fetch, timeout?: number) => [
    new ResendTransport({ apiKey: 'k', fetch, timeout }),
    new PostmarkTransport({ serverToken: 'k', fetch, timeout }),
    new SendGridTransport({ apiKey: 'k', fetch, timeout }),
    new SesTransport({ region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 'b' }, fetch, timeout }),
  ];

  it('reports network errors as transient MailConnectionErrors', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    }) as typeof globalThis.fetch;

    for (const transport of transports(fetch)) {
      const error = await transport.send(message, send).catch((e) => e);
      expect(error).toBeInstanceOf(MailConnectionError);
      expect(error).toMatchObject({ permanent: false });
      expect(error.message).toMatch(/failed: ECONNREFUSED$/);
    }
  });

  it('times out per request, and passes the caller abort through', async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof globalThis.fetch;

    for (const transport of transports(hang, 50)) {
      const error = await transport.send(message, send).catch((e) => e);
      expect(error).toBeInstanceOf(MailTimeoutError);
      expect(error).toMatchObject({ phase: 'request', timeoutMs: 50, permanent: false });
    }

    const controller = new AbortController();
    const reason = new Error('shutting down');
    const pending = transports(hang, 10_000)[0].send(message, { signal: controller.signal, attempt: 1 });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('reads at most 16 KiB of an error body', async () => {
    const fetch = (async () => new Response('x'.repeat(1_000_000), { status: 500 })) as typeof globalThis.fetch;
    for (const transport of transports(fetch)) {
      const error = await transport.send(message, send).catch((e) => e);
      expect(error).toBeInstanceOf(MailProviderError);
      expect(error.message.length).toBeLessThan(400);
    }
  });

  it('keeps API keys out of logs: inspecting a transport shows none', () => {
    const secret = 'hunter2-very-secret';
    for (const transport of [
      new ResendTransport({ apiKey: secret }),
      new PostmarkTransport({ serverToken: secret }),
      new SendGridTransport({ apiKey: secret }),
      new SesTransport({ region: 'us-east-1', credentials: { accessKeyId: 'AKID', secretAccessKey: secret } }),
    ]) {
      expect(inspect(transport, { depth: 10, showHidden: true })).not.toContain(secret);
      expect(JSON.stringify(transport)).not.toContain(secret);
    }
  });

  it('refuses a plain-http base URL except on localhost', () => {
    expect(() => new ResendTransport({ apiKey: 'k', baseUrl: 'http://api.resend.com' })).toThrow(/must be https/);
    expect(() => new ResendTransport({ apiKey: 'k', baseUrl: 'http://127.0.0.1:8025' })).not.toThrow();
    expect(() => new PostmarkTransport({ serverToken: '' })).toThrow(/serverToken/);
    expect(() => new ResendTransport({ apiKey: 'k', timeout: '1 minute' as never })).toThrow(/ResendTransport `timeout`/);
  });
});
