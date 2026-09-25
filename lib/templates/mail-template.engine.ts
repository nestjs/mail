import type { MailTemplateOutput, MailTemplateRenderOptions } from '../interfaces/mail-template.interface.js';

/**
 * Renders a mail's body from a named template: `FileTemplateEngine`, or your own on
 * Handlebars, EJS or MJML. Given to `MailModule` as `templates`, an instance or a class
 * (Nest instantiates it, so it can inject providers). The abstract class is also the
 * injection token.
 *
 * `render()` returns the HTML, or the HTML and the text version, as a value or a promise.
 * The HTML is sent as it is, so the engine escapes the values it inserts. A template that
 * doesn't exist or doesn't compile is a `MailTemplateError`, which is never retried.
 */
export abstract class MailTemplateEngine {
  abstract render(
    name: string,
    context: object,
    options: MailTemplateRenderOptions,
  ): MailTemplateOutput | Promise<MailTemplateOutput>;
}
