import type { Type } from '@nestjs/common';
import type { SentMail } from '../transports/sent-mail.js';

/**
 * Which mails to match: every given field must match. `to` matches any recipient (to,
 * cc or bcc), ignoring case. A function gets each `SentMail`.
 */
export type SentMailQuery =
  | {
      to?: string;
      subject?: string | RegExp;
      /** The mail class that rendered it. */
      mail?: Type;
    }
  | ((mail: SentMail) => boolean);
