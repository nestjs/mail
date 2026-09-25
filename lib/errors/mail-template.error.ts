import { MailError } from './mail.error.js';

/**
 * A mail's template can't be rendered: it doesn't exist, it doesn't compile (an unclosed
 * block, a helper call, a value in an unquoted attribute), or no template engine is
 * configured. Permanent: sending the same mail again renders the same template. A
 * compile error names the file and the position, as in
 * `order-confirmation.html:12:5: {{/each}} closes {{#if paid}}, opened at 10:3`.
 */
export class MailTemplateError extends MailError {
  /** The template name the mail asked for, e.g. `order-confirmation`, when known. */
  declare readonly template?: string;
  /** The absolute path of the file the problem is in. */
  declare readonly file?: string;
  /** The problem's line in `file`, from 1. */
  declare readonly line?: number;
  /** The problem's column in `file`, from 1. */
  declare readonly column?: number;

  constructor(
    problem: string,
    init: {
      template?: string;
      file?: string;
      /** How the message names the file: its path relative to the templates directory. */
      shownAs?: string;
      line?: number;
      column?: number;
      cause?: unknown;
    } = {},
  ) {
    const { template, file, shownAs, line, column, cause } = init;
    const at = line === undefined ? '' : `:${line}:${column ?? 1}`;
    super(file === undefined ? problem : `${shownAs ?? file}${at}: ${problem}`, { permanent: true, cause });

    const fields = { template, file, line, column };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        (this as Record<string, unknown>)[key] = value;
      }
    }
  }
}
