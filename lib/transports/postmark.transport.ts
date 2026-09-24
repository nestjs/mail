import type { PostmarkTransportOptions } from '../interfaces/provider-transport-options.interface.js';
import { MailProviderError } from '../errors/mail-provider.error.js';
import type { MailTransportResult, MailTransportSendOptions } from '../interfaces/mail-transport.interface.js';
import type { MailMessage } from '../message/mail-message.js';
import { field, formatAddress, HttpProviderTransport, type ProviderResponse } from './http-provider.transport.js';
import { checkBaseUrl } from './resend.transport.js';

/**
 * Postmark's `POST /email`. Postmark has no idempotency keys and assigns its own
 * `Message-ID`, so a redelivered mail can be sent twice. Postmark allows 50 recipients
 * and 10 MB per message.
 */
export class PostmarkTransport extends HttpProviderTransport {
  readonly #token: string;
  private readonly stream: string;
  private readonly url: string;

  constructor(options: PostmarkTransportOptions) {
    super('Postmark', options);
    if (typeof options?.serverToken !== 'string' || !options.serverToken) {
      throw new TypeError('PostmarkTransport `serverToken` is required');
    }
    this.#token = options.serverToken;
    this.stream = options.messageStream ?? 'outbound';
    this.url = `${checkBaseUrl(options.baseUrl ?? 'https://api.postmarkapp.com', 'PostmarkTransport')}/email`;
  }

  async send(message: MailMessage, { signal }: MailTransportSendOptions): Promise<MailTransportResult> {
    const list = (addresses: MailMessage['to']) => addresses.map(formatAddress).join(', ');
    const body = {
      From: formatAddress(message.from),
      To: list(message.to),
      ...(message.cc.length && { Cc: list(message.cc) }),
      ...(message.bcc.length && { Bcc: list(message.bcc) }),
      ...(message.replyTo.length && { ReplyTo: list(message.replyTo) }),
      Subject: message.subject,
      ...(message.html !== undefined && { HtmlBody: message.html }),
      ...(message.text && { TextBody: message.text }), // an empty body is not one Postmark accepts
      ...(Object.keys(message.headers).length && {
        Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })),
      }),
      ...(message.attachments.length && {
        Attachments: message.attachments.map((a) => ({
          Name: a.filename ?? a.cid,
          Content: a.content.toString('base64'),
          ContentType: a.contentType,
          ...(a.cid && { ContentID: `cid:${a.cid}` }),
        })),
      }),
      MessageStream: this.stream,
    };

    const response = await this.request(
      this.url,
      {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-postmark-server-token': this.#token,
        },
        body: JSON.stringify(body),
      },
      signal,
    );
    return { accepted: message.envelope.to, providerMessageId: field(response.body, 'MessageID') };
  }

  protected toError({ status, body, headers }: ProviderResponse): MailProviderError {
    // ErrorCode is Postmark's own numbering (406: inactive recipient, 300: invalid email), not the HTTP status
    return new MailProviderError({
      provider: 'postmark',
      status,
      providerCode: field(body, 'ErrorCode') ?? headers.get('x-pm-apierrorcode') ?? undefined,
      detail: field(body, 'Message') ?? (typeof body === 'string' ? body : undefined),
    });
  }
}
