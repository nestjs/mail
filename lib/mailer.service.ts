import { Inject, Injectable, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { MailEvents } from './events/mail-events.service.js';
import { MailTransport } from './transports/mail.transport.js';
import { MailError } from './errors/mail.error.js';
import type { Mailable, MailableRenderOptions, MailableSendOptions } from './interfaces/mailable.interface.js';
import type { MailDeliveryOptions, MailSendOptions, MailSendResult } from './interfaces/mail-send.interface.js';
import type { MailModuleOptions } from './interfaces/mail-module-options.interface.js';
import { MAIL_MODULE_OPTIONS } from './mail.module-definition.js';
import { parseAddress, parseAddressList } from './message/address.util.js';
import { checkHeaderName, checkHeaderValue } from './message/headers.util.js';
import type { MailMessage } from './message/mail-message.js';
import { assertRecipients, createMailMessage, type NormalizeInput } from './message/normalize.util.js';
import type { MailContent } from './interfaces/mail-message.interface.js';
import { backoffDelay, type ResolvedRetry, resolveRetry, sleep } from './utils/retry.util.js';

/**
 * Sends mail: a message written inline, or one rendered by a mail class.
 *
 * ```ts
 * await mailer.send({ to: user.email, subject: 'Welcome', html: html`<p>Hi ${user.name}</p>` });
 * await mailer.send(OrderShippedMail, { to: customer.email, data: order, locale: customer.locale });
 * ```
 *
 * The whole message is validated before anything is sent (`MailMessageError`). Failures
 * that aren't `permanent` are retried with backoff (3 attempts by default); the final
 * error is thrown, and published as a `failed` event.
 */
@Injectable()
export class Mailer {
  private readonly retry: ResolvedRetry;
  private readonly mails = new Map<Type, Promise<Mailable<any>>>();
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    @Inject(MAIL_MODULE_OPTIONS) private readonly options: MailModuleOptions,
    private readonly transport: MailTransport,
    private readonly events: MailEvents,
    private readonly moduleRef: ModuleRef,
  ) {
    this.retry = resolveRetry(options.retry, 'MailModule');
    checkDefaults(options);
  }

  /** Sends a message written inline. */
  send(message: MailSendOptions): Promise<MailSendResult>;
  /** Renders `mail` with `options.data` and sends it. */
  send<M extends Mailable<any>>(
    mail: Type<M>,
    options: MailableSendOptions<Parameters<M['render']>[0]>,
  ): Promise<MailSendResult>;
  send(
    target: MailSendOptions | Type<Mailable<unknown>>,
    options?: MailableSendOptions<unknown>,
  ): Promise<MailSendResult> {
    const run = this.compose(target, options ?? {}).then((message) =>
      this.deliver(message, typeof target === 'function' ? options ?? {} : target),
    );

    this.inFlight.add(run);
    const forget = () => this.inFlight.delete(run);
    run.then(forget, forget);
    return run;
  }

  /**
   * Renders a mail class without sending it: for previews (return `message.html` from a
   * development route) and tests. Recipients are optional here.
   */
  render<M extends Mailable<any>>(
    mail: Type<M>,
    options: MailableRenderOptions<Parameters<M['render']>[0]>,
  ): Promise<MailMessage> {
    return this.renderMail(mail, options as MailableRenderOptions<unknown>);
  }

  /** @internal Resolves once every send started so far has settled. */
  async drain(): Promise<void> {
    while (this.inFlight.size) {
      await Promise.allSettled(this.inFlight);
    }
  }

  private async compose(
    target: MailSendOptions | Type<Mailable<unknown>>,
    options: MailableSendOptions<unknown>,
  ): Promise<MailMessage> {
    const message =
      typeof target === 'function'
        ? await this.renderMail(target, options)
        : await createMailMessage(target as NormalizeInput, this.options);
    assertRecipients(message);
    return message;
  }

  private async renderMail(
    type: Type<Mailable<unknown>>,
    options: MailableRenderOptions<unknown> & MailDeliveryOptions,
  ): Promise<MailMessage> {
    const mail = await this.resolve(type);
    const to = parseAddressList(options.to, 'to');
    const content: MailContent = await mail.render(options.data, { locale: options.locale, to });
    if (!content || typeof content !== 'object') {
      throw new TypeError(`${type.name}.render() must return { subject, html?, text? }`);
    }

    return createMailMessage(
      {
        ...content,
        to: options.to,
        cc: options.cc,
        bcc: options.bcc,
        from: options.from ?? content.from,
        replyTo: options.replyTo ?? content.replyTo,
        attachments: [...(content.attachments ?? []), ...(options.attachments ?? [])],
        headers: { ...content.headers, ...options.headers },
        mail: type,
        locale: options.locale,
        idempotencyKey: options.idempotencyKey,
      },
      this.options,
    );
  }

  /**
   * A mail class that is a provider anywhere in the app is used as is, so it can inject
   * that module's providers. Otherwise it is created once, in the mail module's scope,
   * where global modules (config, i18n) are visible.
   */
  private resolve(type: Type<Mailable<unknown>>): Promise<Mailable<unknown>> {
    if (typeof type?.prototype?.render !== 'function') {
      throw new TypeError(`${type?.name ?? String(type)} is not a mail class: it has no render() method`);
    }

    let mail = this.mails.get(type);
    if (!mail) {
      mail = this.lookup(type);
      this.mails.set(type, mail);
      // A failed creation (a missing dependency) is reported to every caller, then retried
      mail.catch(() => this.mails.delete(type));
    }

    return mail;
  }

  private async lookup(type: Type<Mailable<unknown>>): Promise<Mailable<unknown>> {
    try {
      return this.moduleRef.get(type, { strict: false });
    } catch {
      return this.moduleRef.create(type);
    }
  }

  private async deliver(message: MailMessage, delivery: MailDeliveryOptions): Promise<MailSendResult> {
    const retry = delivery.retry === undefined ? this.retry : resolveRetry(delivery.retry, 'Mailer.send()');
    const signal = delivery.signal ?? new AbortController().signal;
    const transport = this.transport.constructor.name;
    const recipients = message.envelope.to;
    const base = {
      messageId: message.messageId,
      ...(message.mail && { mail: message.mail.name }),
      recipients,
      subject: message.subject,
      transport,
    };

    const started = performance.now();
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      try {
        const result = await this.transport.send(message, {
          signal,
          attempt,
          ...(delivery.idempotencyKey !== undefined && { idempotencyKey: delivery.idempotencyKey }),
        });
        const durationMs = Math.round(performance.now() - started);
        this.events.emit({
          type: 'sent',
          ...base,
          attempts: attempt,
          durationMs,
          ...(result?.providerMessageId && { providerMessageId: result.providerMessageId }),
        });

        return {
          messageId: message.messageId,
          accepted: result?.accepted ?? recipients,
          attempts: attempt,
          ...(result?.providerMessageId && { providerMessageId: result.providerMessageId }),
          ...(result?.response && { response: result.response }),
        };
      } catch (sendError) {
        let error = sendError;
        const aborted = signal.aborted && error === signal.reason;
        let retryable = !aborted && attempt < retry.attempts && isTransient(error);

        // A `retryIf` or `backoff` function that throws ends the send with its error, still
        // reported as `failed`, instead of leaving the outcome without an event
        try {
          if (retryable && retry.retryIf) {
            retryable = retry.retryIf(error, attempt) !== false;
          }
          if (retryable) {
            await sleep(backoffDelay(retry, attempt, error), signal);
            continue;
          }
        } catch (abortOrCallbackError) {
          error = abortOrCallbackError;
        }

        this.events.emit({
          type: 'failed',
          ...base,
          attempts: attempt,
          durationMs: Math.round(performance.now() - started),
          error,
          permanent: !isTransient(error),
        });
        throw error;
      }
    }
  }
}

/**
 * Whether a retry could help: not for a `permanent` error, nor for one carrying a 4xx
 * `status` (the family's "caller's mistake" marker). Other errors, including ones a
 * custom transport throws without either, count as transient.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof MailError) {
    return !error.permanent;
  }

  const { permanent, status } = (error ?? {}) as { permanent?: unknown; status?: unknown };
  if (permanent === true) {
    return false;
  }
  return !(typeof status === 'number' && status >= 400 && status < 500);
}

/** The module's `from`, `replyTo` and `headers`, checked at startup rather than on the first send. */
function checkDefaults(options: MailModuleOptions): void {
  const prefix = (error: unknown) => {
    if (error instanceof Error) {
      error.message = `MailModule: ${error.message}`;
    }
    return error;
  };

  try {
    if (options.from !== undefined) {
      parseAddress(options.from, 'from');
    }
    parseAddressList(options.replyTo, 'replyTo');
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      checkHeaderName(name, `headers.${name}`);
      checkHeaderValue(value, `headers.${name}`);
    }
  } catch (error) {
    throw prefix(error);
  }
}
