import type { SendGridTransportOptions } from '../interfaces/provider-transport-options.interface.js';
import { MailMessageError } from '../errors/mail-message.error.js';
import { MailProviderError } from '../errors/mail-provider.error.js';
import type { MailTransportResult, MailTransportSendOptions } from '../interfaces/mail-transport.interface.js';
import type { MailAddress } from '../interfaces/mail-message.interface.js';
import type { MailMessage } from '../message/mail-message.js';
import { HttpProviderTransport, type ProviderResponse } from './http-provider.transport.js';
import { checkBaseUrl } from './resend.transport.js';

/**
 * SendGrid's `POST /v3/mail/send`, one personalization per message. SendGrid has no
 * idempotency keys, so a redelivered mail can be sent twice. It needs at least one `to`.
 */
export class SendGridTransport extends HttpProviderTransport {
  readonly #apiKey: string;
  private readonly url: string;

  constructor(options: SendGridTransportOptions) {
    super('SendGrid', options);
    if (typeof options?.apiKey !== 'string' || !options.apiKey) {
      throw new TypeError('SendGridTransport `apiKey` is required');
    }
    this.#apiKey = options.apiKey;
    this.url = `${checkBaseUrl(options.baseUrl ?? 'https://api.sendgrid.com', 'SendGridTransport')}/v3/mail/send`;
  }

  async send(message: MailMessage, { signal }: MailTransportSendOptions): Promise<MailTransportResult> {
    if (!message.to.length) {
      throw new MailMessageError('to', 'is required by SendGrid (cc or bcc alone is not enough)');
    }

    const person = (a: MailAddress) => ({ email: a.address, ...(a.name && { name: a.name }) });
    const content = [
      // text/plain first, then text/html: SendGrid refuses another order
      ...(message.text ? [{ type: 'text/plain', value: message.text }] : []),
      ...(message.html ? [{ type: 'text/html', value: message.html }] : []),
    ];

    const body = {
      personalizations: [
        {
          to: message.to.map(person),
          ...(message.cc.length && { cc: message.cc.map(person) }),
          ...(message.bcc.length && { bcc: message.bcc.map(person) }),
        },
      ],
      from: person(message.from),
      ...(message.replyTo.length && { reply_to_list: message.replyTo.map(person) }),
      subject: message.subject,
      content: content.length ? content : [{ type: 'text/plain', value: ' ' }],
      ...(Object.keys(message.headers).length && { headers: message.headers }),
      ...(message.attachments.length && {
        attachments: message.attachments.map((a) => ({
          content: a.content.toString('base64'),
          filename: a.filename ?? a.cid,
          type: a.contentType,
          disposition: a.disposition,
          ...(a.cid && { content_id: a.cid }),
        })),
      }),
    };

    const response = await this.request(
      this.url,
      {
        headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      signal,
    );
    return { accepted: message.envelope.to, providerMessageId: response.headers.get('x-message-id') ?? undefined };
  }

  protected toError({ status, body, retryAfterMs }: ProviderResponse): MailProviderError {
    const errors = (body as { errors?: { message?: string; field?: string | null }[] } | undefined)?.errors;
    const detail = Array.isArray(errors)
      ? errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).filter(Boolean).join('; ')
      : typeof body === 'string'
        ? body
        : undefined;
    return new MailProviderError({ provider: 'sendgrid', status, detail, retryAfterMs });
  }
}
