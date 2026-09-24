import type { MailAddress, MailAddressInput, MailContent, MailRecipients } from './mail-message.interface.js';
import type { MailDeliveryOptions } from './mail-send.interface.js';

/**
 * A mail class: an injectable provider whose `render()` turns data into a subject and a
 * body. It can inject whatever it needs (`I18nService`, a repository, configuration).
 *
 * ```ts
 * @Injectable()
 * export class OrderShippedMail implements Mailable<Order> {
 *   render(order: Order, { locale }: MailRenderContext) {
 *     return { subject: `Order #${order.id} shipped`, html: html`<p>On its way!</p>` };
 *   }
 * }
 * ```
 */
export interface Mailable<TData = void> {
  render(data: TData, context: MailRenderContext): MailContent | Promise<MailContent>;
}

/** What `render()` gets besides the data. */
export interface MailRenderContext {
  /** The `locale` passed to `send()` or `render()`, if any. Pass it to `I18nService#t()`. */
  readonly locale: string | undefined;
  /** The parsed `to` recipients (empty for a preview without them). */
  readonly to: readonly MailAddress[];
}

/** The data type a mail class renders. */
export type MailData<M> = M extends Mailable<infer TData> ? TData : never;

/** `mailer.send(MailClass, { ... })`. `data` is required unless the class renders `void`. */
export type MailableSendOptions<TData> = MailRecipients &
  MailDeliveryOptions &
  MailableOverrides &
  MailableData<TData>;

/** `mailer.render(MailClass, { ... })`: the same, without delivery options. Recipients are optional. */
export type MailableRenderOptions<TData> = MailRecipients & MailableOverrides & MailableData<TData>;

interface MailableOverrides {
  /** The locale to render in, handed to `render()` as `context.locale`. */
  locale?: string;
  /** Overrides what `render()` returned, and the module's `from`. */
  from?: MailAddressInput;
  replyTo?: MailAddressInput | MailAddressInput[];
  /** Added to the attachments `render()` returned. */
  attachments?: MailContent['attachments'];
  /** Merged over the headers `render()` returned. */
  headers?: Record<string, string>;
}

type MailableData<TData> = [TData] extends [void] ? { data?: undefined } : undefined extends TData ? { data?: TData } : { data: TData };
