import { truncate } from '../utils/truncate.util.js';
import { MailError } from './mail.error.js';

/**
 * The SMTP server answered a command with an error reply. `permanent` follows the
 * reply code: 5xx is permanent, 4xx transient (greylisting, a full mailbox, a rate
 * limit). A failed `AUTH` (535) is permanent.
 */
export class MailSmtpError extends MailError {
  declare readonly code: number;
  /** The enhanced status code (RFC 3463), e.g. `5.1.1`, when the server sent one. */
  declare readonly enhancedCode?: string;
  /** The command that failed: `EHLO`, `STARTTLS`, `AUTH`, `MAIL FROM`, `RCPT TO`, `DATA`. */
  readonly command: string;
  /** The server's reply text, without the code. */
  readonly response: string;

  constructor(command: string, reply: { code: number; enhancedCode?: string; text: string }, detail?: string) {
    super(
      `SMTP ${command} failed with ${reply.code}${reply.enhancedCode ? ` ${reply.enhancedCode}` : ''}: ` +
        `${truncate(reply.text)}${detail ? ` (${detail})` : ''}`,
      { permanent: reply.code >= 500, code: reply.code },
    );

    this.command = command;
    this.response = reply.text;
    if (reply.enhancedCode) {
      (this as { enhancedCode?: string }).enhancedCode = reply.enhancedCode;
    }
  }
}
