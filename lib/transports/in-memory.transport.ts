import type { MailTransportResult } from '../interfaces/mail-transport.interface.js';
import type { SentMailQuery } from '../interfaces/sent-mail-query.interface.js';
import { LOCAL_TRANSPORT } from '../mail.constants.js';
import type { MailMessage } from '../message/mail-message.js';
import { MailTransport } from './mail.transport.js';
import { SentMail } from './sent-mail.js';

/**
 * Keeps sent mail in memory, for tests. Replace the app's transport with it:
 *
 * ```ts
 * const mailbox = new InMemoryMailTransport();
 * Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MailTransport).useValue(mailbox);
 * // ...
 * const mail = mailbox.assertSent({ to: 'ada@example.com', mail: PasswordResetMail });
 * const token = mail.link('/reset-password').searchParams.get('token');
 * ```
 *
 * The assertion helpers throw plain `Error`s with a description of what was sent, so they
 * work with any test runner.
 */
export class InMemoryMailTransport extends MailTransport {
  readonly [LOCAL_TRANSPORT] = true;
  #mails: SentMail[] = [];
  #failures: unknown[] = [];

  /** Every mail received so far, oldest first. */
  get mails(): readonly SentMail[] {
    return [...this.#mails];
  }

  async send(message: MailMessage): Promise<MailTransportResult> {
    if (this.#failures.length) {
      throw this.#failures.shift();
    }
    this.#mails.push(new SentMail(message, new Date()));
    return { accepted: message.envelope.to };
  }

  /** The mails matching `query`, oldest first (all of them without a query). */
  filter(query?: SentMailQuery): SentMail[] {
    return this.#mails.filter((mail) => matches(mail, query));
  }

  /** The most recent mail matching `query`, or `undefined`. */
  find(query?: SentMailQuery): SentMail | undefined {
    return this.filter(query).at(-1);
  }

  /** The most recent mail matching `query`; throws, listing what was sent, when there is none. */
  assertSent(query?: SentMailQuery): SentMail {
    const found = this.find(query);
    if (!found) {
      throw new Error(`Expected a mail ${describe(query)}, but none was sent. ${this.summary()}`);
    }
    return found;
  }

  /** Throws when a mail matching `query` was sent (any mail at all, without a query). */
  assertNotSent(query?: SentMailQuery): void {
    const found = this.find(query);
    if (found) {
      throw new Error(`Expected no mail ${describe(query)}, but "${found.subject}" was sent. ${this.summary()}`);
    }
  }

  /** Makes the next `send()` throw `error`, once per call: to test how the app handles failures. */
  failNext(error: unknown): void {
    this.#failures.push(error);
  }

  /** Forgets the mails and any pending `failNext()` errors, e.g. in `beforeEach`. */
  clear(): void {
    this.#mails = [];
    this.#failures = [];
  }

  private summary(): string {
    if (!this.#mails.length) {
      return 'No mail was sent.';
    }
    const lines = this.#mails.map(
      (mail) =>
        `  - "${mail.subject}" to ${mail.message.envelope.to.join(', ')}` +
        `${mail.mail ? ` (${mail.mail.name})` : ''}${mail.template ? ` [${mail.template}]` : ''}`,
    );
    return `Sent:\n${lines.join('\n')}`;
  }
}

function matches(mail: SentMail, query: SentMailQuery | undefined): boolean {
  if (query === undefined) {
    return true;
  }
  if (typeof query === 'function') {
    return query(mail);
  }

  if (query.to !== undefined) {
    const wanted = query.to.toLowerCase();
    if (!mail.message.envelope.to.some((address) => address.toLowerCase() === wanted)) {
      return false;
    }
  }
  if (query.subject !== undefined) {
    const ok = typeof query.subject === 'string' ? mail.subject === query.subject : query.subject.test(mail.subject);
    if (!ok) {
      return false;
    }
  }

  if (query.template !== undefined && mail.template !== query.template) {
    return false;
  }

  return query.mail === undefined || mail.mail === query.mail;
}

function describe(query: SentMailQuery | undefined): string {
  if (query === undefined) {
    return '';
  }
  if (typeof query === 'function') {
    return 'matching the predicate';
  }

  const parts: string[] = [];
  if (query.mail) {
    parts.push(`rendered by ${query.mail.name}`);
  }
  if (query.template !== undefined) {
    parts.push(`from the template ${query.template}`);
  }
  if (query.to !== undefined) {
    parts.push(`to ${query.to}`);
  }
  if (query.subject !== undefined) {
    parts.push(`with subject ${String(query.subject)}`);
  }

  return parts.join(' ');
}
