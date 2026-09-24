/** What a transport gets besides the message. */
export interface MailTransportSendOptions {
  /** Aborts when the caller cancels. A transport stops what it is doing and rejects with `signal.reason`. */
  signal: AbortSignal;
  /** The caller's `idempotencyKey`, for providers that deduplicate requests. */
  idempotencyKey?: string;
  /** 1 for the first attempt. */
  attempt: number;
}

/** What a transport reports after the message was accepted. */
export interface MailTransportResult {
  /** Envelope recipients the server accepted. Defaults to all of them. */
  accepted?: string[];
  /** The provider's id for the message. */
  providerMessageId?: string;
  /** The final server reply. */
  response?: string;
}
