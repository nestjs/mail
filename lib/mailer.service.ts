import { Inject, Injectable, Optional, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { MailEvents } from './events/mail-events.service.js';
import { MailTransport } from './transports/mail.transport.js';
import { MailError } from './errors/mail.error.js';
import { MailMessageError } from './errors/mail-message.error.js';
import { MailTemplateError } from './errors/mail-template.error.js';
import type { Mailable, MailableRenderOptions, MailableSendOptions } from './interfaces/mailable.interface.js';
import type {
  MailDeliveryOptions,
  MailRenderOptions,
  MailSendOptions,
  MailSendResult,
} from './interfaces/mail-send.interface.js';
import type { MailModuleOptions } from './interfaces/mail-module-options.interface.js';
import { MAIL_MODULE_OPTIONS } from './mail.module-definition.js';
import { parseAddress, parseAddressList } from './message/address.util.js';
import { checkHeaderName, checkHeaderValue } from './message/headers.util.js';
import type { MailMessage } from './message/mail-message.js';
import { assertRecipients, createMailMessage, type NormalizeInput } from './message/normalize.util.js';
import type { MailContent, MailRecipients, MailTemplateContent } from './interfaces/mail-message.interface.js';
import { MailTemplateEngine } from './templates/mail-template.engine.js';
import { type ResolvedRetry, resolveRetry, retryDelay, sleep } from './utils/retry.util.js';

/**
 * Sends mail: a message written inline, or one rendered by a mail class.
 *
 * ```ts
 * await mailer.send({ to: user.email, subject: 'Welcome', html: html`<p>Hi ${user.name}</p>` });
 * await mailer.send({ to: user.email, subject: 'Welcome', template: 'welcome', context: { name: user.name } });
 * await mailer.send(OrderShippedMail, { to: customer.email, data: order, locale: customer.locale });
 * ```
 *
 * The whole message is validated before anything is sent (`MailMessageError`). Failures
 * that aren't `permanent` are retried with backoff (3 attempts by default), waiting at
 * least as long as a provider's `Retry-After` asks, up to `maxDelay`; the final error is
 * thrown, and published as a `failed` event.
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
    @Optional() @Inject(MailTemplateEngine) private readonly templates?: MailTemplateEngine | null,
  ) {
    this.retry = resolveRetry(options.retry, 'MailModule');
    checkDefaults(options);
  }

  /** Sends a message written inline, as HTML or from a template. */
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
  ): Promise<MailMessage>;
  /** Renders a message written inline, such as `{ subject, template, context }`, without sending it. */
  render(message: MailRenderOptions): Promise<MailMessage>;
  render(target: MailRenderOptions | Type<Mailable<unknown>>, options?: MailableRenderOptions<unknown>): Promise<MailMessage> {
    if (typeof target === 'function') {
      return this.renderMail(target, options ?? {});
    }
    return this.renderInline(target);
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
    const message = typeof target === 'function' ? await this.renderMail(target, options) : await this.renderInline(target);
    assertRecipients(message);
    return message;
  }

  private async renderInline(message: MailRenderOptions & MailDeliveryOptions): Promise<MailMessage> {
    if (!message || typeof message !== 'object') {
      throw new TypeError('Mailer: pass a mail class, or a message such as { to, subject, html }');
    }
    return createMailMessage(await this.fromTemplate(message, message.locale), this.options);
  }

  private async renderMail(
    type: Type<Mailable<unknown>>,
    options: MailableRenderOptions<unknown> & MailDeliveryOptions,
  ): Promise<MailMessage> {
    const mail = await this.resolve(type);
    const to = parseAddressList(options.to, 'to');
    const rendered = await mail.render(options.data, { locale: options.locale, to });
    if (!rendered || typeof rendered !== 'object') {
      throw new TypeError(`${type.name}.render() must return { subject, html?, text? } or { subject, template, context? }`);
    }
    const content = await this.fromTemplate(rendered, options.locale);

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
   * Renders the template that the content names, if any, into its `html` (and `text`, when
   * the engine gives one). Content without a template passes through.
   */
  private async fromTemplate(
    content: (MailContent | MailTemplateContent) & MailRecipients & { idempotencyKey?: string; locale?: string },
    locale: string | undefined,
  ): Promise<NormalizeInput> {
    const { template, context, ...rest } = content;
    if (template === undefined) {
      if (context !== undefined) {
        throw new MailMessageError('context', 'is only used with `template`');
      }
      return rest as NormalizeInput;
    }

    if (typeof template !== 'string' || !template) {
      throw new MailMessageError('template', 'must be a non-empty string');
    }
    for (const field of ['html', 'text'] as const) {
      if (rest[field] !== undefined) {
        throw new MailMessageError(
          'template',
          `and \`${field}\` are both set: the template renders the body (a .txt template the text)`,
        );
      }
    }
    if (context !== undefined && (context === null || typeof context !== 'object')) {
      throw new MailMessageError('context', 'must be an object');
    }
    if (!this.templates) {
      throw new MailTemplateError(
        `The mail names the template "${template}", but MailModule has no template engine: pass ` +
          "`templates: new FileTemplateEngine({ dir: 'templates' })`, or your own MailTemplateEngine, to forRoot()",
        { template },
      );
    }

    const output = await this.templates.render(template, context ?? {}, { locale });
    const { html, text } = typeof output === 'string' ? { html: output, text: undefined } : (output ?? {});
    if (typeof html !== 'string' || (text !== undefined && typeof text !== 'string')) {
      throw new TypeError(
        `${this.templates.constructor.name}.render() must return the HTML as a string, or { html, text? }`,
      );
    }

    return { ...rest, html, ...(text !== undefined && { text }), template } as NormalizeInput;
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
    // Attempts the transport saw: a signal aborted before the first one fails the send with 0.
    let attempts = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        // Inside the try, so an abort before an attempt is reported as `failed` like any other end.
        signal.throwIfAborted();
        attempts = attempt;
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
            await sleep(retryDelay(retry, attempt, error), signal);
            continue;
          }
        } catch (abortOrCallbackError) {
          error = abortOrCallbackError;
        }

        this.events.emit({
          type: 'failed',
          ...base,
          attempts,
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
