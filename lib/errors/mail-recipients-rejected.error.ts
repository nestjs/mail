import { MailSmtpError } from './mail-smtp.error.js';

/**
 * The server refused one or more recipients, so the message was not sent to anyone:
 * the transaction is reset before `DATA`, which keeps a retry from delivering twice.
 * Permanent when any refusal is permanent (5xx), since that recipient never succeeds.
 */
export class MailRecipientsRejectedError extends MailSmtpError {
  readonly rejected: readonly { address: string; code: number; enhancedCode?: string; response: string }[];

  constructor(rejected: MailRecipientsRejectedError['rejected']) {
    const worst = rejected.find((r) => r.code >= 500) ?? rejected[0];
    super(
      'RCPT TO',
      { code: worst.code, enhancedCode: worst.enhancedCode, text: worst.response },
      `${rejected.length} recipient(s) refused: ${rejected.map((r) => r.address).join(', ')}`,
    );
    this.rejected = rejected;
  }
}
