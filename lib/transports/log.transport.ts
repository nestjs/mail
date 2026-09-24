import type { LogMailTransportOptions } from '../interfaces/local-transport-options.interface.js';
import { Logger, type LoggerService } from '@nestjs/common';
import { LOCAL_TRANSPORT } from '../mail.constants.js';
import { MailTransport } from './mail.transport.js';
import type { MailTransportResult } from '../interfaces/mail-transport.interface.js';
import type { MailMessage } from '../message/mail-message.js';

/**
 * Logs each message instead of sending it: recipients and subject at `log` level, the
 * text body at `debug`. For development and demos; a body can hold sign-in links, so
 * never use it where logs are shipped.
 */
export class LogMailTransport extends MailTransport {
  readonly [LOCAL_TRANSPORT] = true;
  private readonly logger: LoggerService;
  private readonly body: boolean;

  constructor(options: LogMailTransportOptions = {}) {
    super();
    this.logger = options.logger ?? new Logger(LogMailTransport.name);
    this.body = options.body ?? true;
  }

  async send(message: MailMessage): Promise<MailTransportResult> {
    const attachments = message.attachments.length
      ? ` with ${message.attachments.length} attachment(s): ${message.attachments.map((a) => a.filename ?? `cid:${a.cid}`).join(', ')}`
      : '';
    this.logger.log(`"${message.subject}" to ${message.envelope.to.join(', ')}${attachments}`);
    if (this.body && message.text) {
      this.logger.debug?.(message.text);
    }
    return { accepted: message.envelope.to };
  }
}
