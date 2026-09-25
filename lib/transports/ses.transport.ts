import type {
  AwsCredentials,
  SesTransportOptions,
} from '../interfaces/provider-transport-options.interface.js';
import { MailProviderError } from '../errors/mail-provider.error.js';
import type { MailTransportResult, MailTransportSendOptions } from '../interfaces/mail-transport.interface.js';
import type { MailMessage } from '../message/mail-message.js';
import { field, HttpProviderTransport, type ProviderResponse } from './http-provider.transport.js';
import { checkBaseUrl } from './resend.transport.js';
import { signV4 } from './sigv4.util.js';

/** Error codes that mean "slow down", not "this message is wrong". */
const THROTTLING = new Set([
  'TooManyRequestsException',
  'LimitExceededException',
  'ThrottlingException',
  'Throttling',
  'RequestThrottled',
]);

/**
 * Amazon SES v2 `SendEmail` with raw MIME content, signed with Signature Version 4 on
 * `node:crypto`: the message goes out exactly as the other transports build it,
 * attachments and inline images included. SES has no idempotency keys, and replaces
 * the `Message-ID` with its own (`providerMessageId`).
 */
export class SesTransport extends HttpProviderTransport {
  private readonly region: string;
  private readonly url: URL;
  readonly #credentials: SesTransportOptions['credentials'];
  private readonly configurationSetName?: string;

  constructor(options: SesTransportOptions = {}) {
    super('SES', options);

    const region = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) {
      throw new TypeError('SesTransport `region` is required (or AWS_REGION), e.g. "eu-west-1"');
    }

    this.region = region;
    const endpoint = checkBaseUrl(options.endpoint ?? `https://email.${region}.amazonaws.com`, 'SesTransport');
    this.url = new URL(`${endpoint}/v2/email/outbound-emails`);

    this.#credentials = options.credentials ?? fromEnvironment();
    if (typeof this.#credentials !== 'function') {
      checkCredentials(this.#credentials);
    }
    this.configurationSetName = options.configurationSetName;
  }

  async send(message: MailMessage, { signal }: MailTransportSendOptions): Promise<MailTransportResult> {
    const addresses = (list: MailMessage['to']) => list.map((a) => a.address);
    const body = JSON.stringify({
      FromEmailAddress: message.from.address,
      // Explicit, so Bcc recipients (never in the MIME headers) receive it too
      Destination: {
        ...(message.to.length && { ToAddresses: addresses(message.to) }),
        ...(message.cc.length && { CcAddresses: addresses(message.cc) }),
        ...(message.bcc.length && { BccAddresses: addresses(message.bcc) }),
      },
      Content: { Raw: { Data: message.toMime().toString('base64') } },
      ...(this.configurationSetName && { ConfigurationSetName: this.configurationSetName }),
    });

    const credentials = typeof this.#credentials === 'function' ? await this.#credentials() : this.#credentials!;
    checkCredentials(credentials);

    const signature = signV4(
      {
        method: 'POST',
        path: this.url.pathname,
        headers: [
          ['host', this.url.host],
          ['content-type', 'application/json'],
        ],
        body,
      },
      { credentials, region: this.region, service: 'ses', date: new Date() },
    );

    const response = await this.request(
      this.url.href,
      {
        headers: { 'content-type': 'application/json', ...signature.headers, authorization: signature.authorization },
        body,
      },
      signal,
    );
    return { accepted: message.envelope.to, providerMessageId: field(response.body, 'MessageId') };
  }

  protected toError({ status, body, headers, retryAfterMs }: ProviderResponse): MailProviderError {
    // `x-amzn-ErrorType` looks like `Name:http://...`; a body `__type` like `com.amazon...#Name`
    const raw = headers.get('x-amzn-errortype') ?? field(body, 'code', 'Code', '__type') ?? '';
    const code = raw.split(':', 1)[0].split('#').pop() || undefined;
    const throttled = code !== undefined && THROTTLING.has(code);

    return new MailProviderError({
      provider: 'ses',
      status,
      providerCode: code,
      detail: field(body, 'message', 'Message') ?? (typeof body === 'string' ? body : undefined),
      ...(throttled && { permanent: false }),
      retryAfterMs,
    });
  }
}

function fromEnvironment(): AwsCredentials | undefined {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    return undefined;
  }
  return {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
    ...(AWS_SESSION_TOKEN && { sessionToken: AWS_SESSION_TOKEN }),
  };
}

function checkCredentials(credentials: AwsCredentials | undefined): void {
  if (!credentials || typeof credentials.accessKeyId !== 'string' || typeof credentials.secretAccessKey !== 'string') {
    throw new TypeError(
      'SesTransport needs `credentials` ({ accessKeyId, secretAccessKey }, or a function returning them) ' +
        'or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment',
    );
  }
}
