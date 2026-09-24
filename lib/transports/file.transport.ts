import type { FileMailTransportOptions } from '../interfaces/local-transport-options.interface.js';
import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { LOCAL_TRANSPORT } from '../mail.constants.js';
import { MailTransport } from './mail.transport.js';
import type { MailTransportResult } from '../interfaces/mail-transport.interface.js';
import type { MailMessage } from '../message/mail-message.js';

/**
 * Writes each message to `<directory>/<time>-<id>.eml` instead of sending it, for
 * development: open the file in any mail client to see exactly what would be sent,
 * attachments and inline images included. Nothing leaves the machine.
 */
export class FileMailTransport extends MailTransport {
  readonly [LOCAL_TRANSPORT] = true;
  private readonly directory: string;
  private readonly log: boolean;
  private readonly logger = new Logger(FileMailTransport.name);

  constructor(options: FileMailTransportOptions) {
    super();
    if (typeof options?.directory !== 'string' || !options.directory) {
      throw new TypeError('FileMailTransport: `directory` must be a path');
    }
    this.directory = resolve(options.directory);
    this.log = options.log ?? true;
  }

  async send(message: MailMessage): Promise<MailTransportResult> {
    await mkdir(this.directory, { recursive: true });

    const stamp = message.date.toISOString().replace(/[:.]/g, '-');
    // The id is ours, but keep the name to characters every file system accepts
    const id = message.messageId.slice(1, message.messageId.indexOf('@')).replace(/[^A-Za-z0-9_-]/g, '');
    // A random suffix: the same mail sent twice in one millisecond (same idempotency key) gets two files
    const path = join(this.directory, `${stamp}-${id}-${randomBytes(3).toString('hex')}.eml`);
    await writeFile(path, message.toMime(), { flag: 'wx' });

    if (this.log) {
      const shown = relative(process.cwd(), path);
      this.logger.log(
        `"${message.subject}" to ${message.envelope.to.join(', ')} written to ${shown.startsWith('..') || isAbsolute(shown) ? path : shown}`,
      );
    }

    return { accepted: message.envelope.to, response: path };
  }
}
