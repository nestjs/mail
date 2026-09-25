import {
  MailConnectionError,
  PostmarkTransport,
  ResendTransport,
  SendGridTransport,
  SesTransport,
} from '../lib/index.js';
import type { MailMessage } from '../lib/message/mail-message.js';
import { createMailMessage } from '../lib/message/normalize.util.js';

interface Captured {
  url: string;
  init: RequestInit;
  body: any;
}

function stubFetch(respond: (request: Captured) => Response | Promise<Response>) {
  const requests: Captured[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const request = { url, init, body: JSON.parse(String(init.body)) };
    requests.push(request);
    return respond(request);
  }) as typeof globalThis.fetch;

  return { fetch, requests };
}

const send = { signal: new AbortController().signal, attempt: 1 };
const credentials = { accessKeyId: 'AKID', secretAccessKey: 'secret' };
let message: MailMessage;

beforeAll(async () => {
  message = await createMailMessage({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' }, { from: 'orders@example.com' });
});

describe('HTTP providers: options', () => {
  it('post to a custom base URL without doubling its trailing slash, and never follow redirects', async () => {
    const { fetch, requests } = stubFetch(() => Response.json({ id: 'x', MessageID: 'x', MessageId: 'x' }));

    await new ResendTransport({ apiKey: 'k', fetch, baseUrl: 'http://localhost:8025/' }).send(message, send);
    await new PostmarkTransport({ serverToken: 'k', fetch, baseUrl: 'https://pm.example//' }).send(message, send);
    await new SendGridTransport({ apiKey: 'k', fetch, baseUrl: 'https://api.eu.sendgrid.com' }).send(message, send);
    await new SesTransport({ region: 'eu-central-1', credentials, fetch, endpoint: 'https://ses.proxy.example' }).send(message, send);

    expect(requests.map((r) => r.url)).toEqual([
      'http://localhost:8025/emails',
      'https://pm.example/email',
      'https://api.eu.sendgrid.com/v3/mail/send',
      'https://ses.proxy.example/v2/email/outbound-emails',
    ]);
    expect(requests.every((r) => r.init.redirect === 'error' && r.init.method === 'POST')).toBe(true);
  });

  it.each([
    ['a base URL that is not a URL', () => new ResendTransport({ apiKey: 'k', baseUrl: 'not a url' }), 'ResendTransport `baseUrl` is not a URL'],
    ['an empty SendGrid apiKey', () => new SendGridTransport({ apiKey: '' }), 'SendGridTransport `apiKey` is required'],
    ['a missing Resend apiKey', () => new ResendTransport({} as never), 'ResendTransport `apiKey` is required'],
    ['a fetch that is not a function', () => new PostmarkTransport({ serverToken: 'k', fetch: 'fetch' as never }), 'PostmarkTransport `fetch` must be a function'],
    ['a malformed SES region', () => new SesTransport({ region: 'europe', credentials }), 'SesTransport `region` is required'],
    ['a plain-http SES endpoint', () => new SesTransport({ region: 'us-east-1', credentials, endpoint: 'http://ses.example' }), 'SesTransport `baseUrl` must be https'],
    ['incomplete SES credentials', () => new SesTransport({ region: 'us-east-1', credentials: { accessKeyId: 'a' } as never }), 'SesTransport needs `credentials`'],
  ])('fails at startup on %s', (_case, make, message) => {
    expect(make).toThrow(message);
  });

  it('Postmark sends to the configured message stream', async () => {
    const { fetch, requests } = stubFetch(() => Response.json({ MessageID: 'm' }));
    await new PostmarkTransport({ serverToken: 't', fetch, messageStream: 'broadcast' }).send(message, send);
    expect(requests[0].body.MessageStream).toBe('broadcast');
  });

  it('leaves out empty lists and headers, and sends no idempotency key without one', async () => {
    const { fetch, requests } = stubFetch(() => Response.json({ id: 'r' }));
    await new ResendTransport({ apiKey: 'k', fetch }).send(message, send);

    expect(requests[0].body).toEqual({ from: 'orders@example.com', to: ['ada@example.com'], subject: 'Hi', text: 'Hello' });
    expect(new Headers(requests[0].init.headers).has('idempotency-key')).toBe(false);
  });

  it('succeeds without a provider message id when the body has none', async () => {
    const { fetch } = stubFetch(() => new Response('queued', { status: 200 }));
    await expect(new ResendTransport({ apiKey: 'k', fetch }).send(message, send)).resolves.toEqual({ accepted: ['ada@example.com'], providerMessageId: undefined });

    const sendgrid = stubFetch(() => new Response(null, { status: 202 }));
    await expect(new SendGridTransport({ apiKey: 'k', fetch: sendgrid.fetch }).send(message, send)).resolves.toMatchObject({ providerMessageId: undefined });
  });
});

describe('HTTP providers: errors', () => {
  it('Resend: quotes a plain-text error body', async () => {
    const { fetch } = stubFetch(() => new Response('Bad Gateway', { status: 502 }));
    const error = await new ResendTransport({ apiKey: 'k', fetch }).send(message, send).catch((e) => e);
    expect(error).toMatchObject({ provider: 'resend', code: 502, permanent: false, message: 'resend refused the message with 502: Bad Gateway' });
  });

  it('Postmark: falls back to the X-PM-ApiErrorCode header for the code', async () => {
    const { fetch } = stubFetch(() => new Response('', { status: 401, headers: { 'x-pm-apierrorcode': '10' } }));
    const error = await new PostmarkTransport({ serverToken: 't', fetch }).send(message, send).catch((e) => e);
    expect(error).toMatchObject({ provider: 'postmark', code: 401, providerCode: '10', permanent: true });
  });

  it('SendGrid: joins errors without a field, and quotes a text body', async () => {
    const json = stubFetch(() => Response.json({ errors: [{ message: 'first', field: null }, { message: 'second', field: 'subject' }] }, { status: 400 }));
    await expect(new SendGridTransport({ apiKey: 'k', fetch: json.fetch }).send(message, send)).rejects.toThrow(
      'sendgrid refused the message with 400: first; subject: second',
    );

    const text = stubFetch(() => new Response('Service Unavailable', { status: 503 }));
    await expect(new SendGridTransport({ apiKey: 'k', fetch: text.fetch }).send(message, send)).rejects.toMatchObject({
      permanent: false,
      message: 'sendgrid refused the message with 503: Service Unavailable',
    });
  });

  it('SES: reads the error type from the body when the header is missing', async () => {
    const { fetch } = stubFetch(() => Response.json({ __type: 'com.amazonaws.ses#ThrottlingException', Message: 'Rate exceeded' }, { status: 400 }));
    const error = await new SesTransport({ region: 'us-east-1', credentials, fetch }).send(message, send).catch((e) => e);
    expect(error).toMatchObject({ providerCode: 'ThrottlingException', permanent: false, message: 'ses refused the message with 400 ThrottlingException: Rate exceeded' });
  });

  it('SES: an unknown 4xx error type is permanent', async () => {
    const { fetch } = stubFetch(() => Response.json({ code: 'AccountSendingPausedException' }, { status: 400 }));
    await expect(new SesTransport({ region: 'us-east-1', credentials, fetch }).send(message, send)).rejects.toMatchObject({
      providerCode: 'AccountSendingPausedException',
      permanent: true,
    });
  });

  it('reports a failure to read the response body as a connection error', async () => {
    const broken = new ReadableStream({
      pull(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    const fetch = (async () => new Response(broken, { status: 200 })) as typeof globalThis.fetch;
    const error = await new ResendTransport({ apiKey: 'k', fetch }).send(message, send).catch((e) => e);

    expect(error).toBeInstanceOf(MailConnectionError);
    expect(error.message).toBe('Resend request to api.resend.com failed: terminated');
  });
});

describe('SesTransport credentials', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('reads the region and credentials (session token included) from the environment', async () => {
    delete process.env.AWS_REGION;
    process.env.AWS_DEFAULT_REGION = 'ap-southeast-2';
    process.env.AWS_ACCESS_KEY_ID = 'AKIDENV';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    process.env.AWS_SESSION_TOKEN = 'session-env';

    const { fetch, requests } = stubFetch(() => Response.json({ MessageId: 'x' }));
    await new SesTransport({ fetch }).send(message, send);

    const headers = new Headers(requests[0].init.headers);
    expect(requests[0].url).toBe('https://email.ap-southeast-2.amazonaws.com/v2/email/outbound-emails');
    expect(headers.get('x-amz-security-token')).toBe('session-env');
    expect(headers.get('authorization')).toMatch(/Credential=AKIDENV\/\d{8}\/ap-southeast-2\/ses\/aws4_request/);
  });

  it('fails the send, before any request, when a credentials function resolves to nothing usable', async () => {
    const { fetch, requests } = stubFetch(() => Response.json({}));
    const transport = new SesTransport({ region: 'us-east-1', fetch, credentials: async () => ({}) as never });

    await expect(transport.send(message, send)).rejects.toThrow(/SesTransport needs `credentials`/);
    expect(requests).toEqual([]);
  });

  it('leaves Destination lists out when they are empty', async () => {
    const { fetch, requests } = stubFetch(() => Response.json({ MessageId: 'x' }));
    const bccOnly = await createMailMessage({ bcc: 'hidden@example.com', subject: 's', text: 't' }, { from: 'a@example.com' });
    await new SesTransport({ region: 'us-east-1', credentials, fetch }).send(bccOnly, send);

    expect(requests[0].body.Destination).toEqual({ BccAddresses: ['hidden@example.com'] });
    expect(requests[0].body).not.toHaveProperty('ConfigurationSetName');
  });
});
