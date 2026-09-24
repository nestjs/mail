interface MailEventBase {
  /** The message's `Message-ID`, `<id@domain>`. */
  messageId: string;
  /** The mail class's name, when the message came from one. */
  mail?: string;
  /** The envelope recipients (to, cc and bcc). */
  recipients: string[];
  subject: string;
  /** The transport's class name, e.g. `SmtpTransport`. */
  transport: string;
  /** Attempts made, including the last one. */
  attempts: number;
  /** From the first attempt to the outcome, waits between attempts included. */
  durationMs: number;
}

/** Channel `nestjs:mail:sent`: the transport accepted the message. */
export interface MailSentEvent extends MailEventBase {
  type: 'sent';
  providerMessageId?: string;
}

/** Channel `nestjs:mail:failed`: the send failed, after its retries. */
export interface MailFailedEvent extends MailEventBase {
  type: 'failed';
  error: unknown;
  /** Whether the last error was permanent (a retry later would fail too). */
  permanent: boolean;
}

export type MailEvent = MailSentEvent | MailFailedEvent;
