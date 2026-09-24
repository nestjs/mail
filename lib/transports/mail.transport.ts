import type { MailTransportResult, MailTransportSendOptions } from '../interfaces/mail-transport.interface.js';
import type { MailMessage } from '../message/mail-message.js';

/**
 * Delivers messages: `SmtpTransport`, the HTTP providers, or your own. The abstract
 * class is also the injection token, so a test replaces the transport with
 * `overrideProvider(MailTransport).useValue(new InMemoryMailTransport())`.
 *
 * `send()` throws a `MailError` whose `permanent` flag says whether a retry could help;
 * anything else it throws is treated as transient. `close()` runs on application
 * shutdown, after the sends in flight have finished.
 */
export abstract class MailTransport {
  abstract send(message: MailMessage, options: MailTransportSendOptions): Promise<MailTransportResult>;
  close?(): void | Promise<void>;
}
