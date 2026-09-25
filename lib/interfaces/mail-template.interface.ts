/** What `MailTemplateEngine#render()` gets besides the template name and the context. */
export interface MailTemplateRenderOptions {
  /** The mail's locale (`send()`'s `locale`), if any: the engine picks the template for it. */
  readonly locale: string | undefined;
}

/**
 * What a template engine renders: the HTML, or the HTML and the plain-text version. Without
 * `text`, the mailer derives it from the HTML.
 */
export type MailTemplateOutput = string | { html: string; text?: string };

/** The options of `FileTemplateEngine`. */
export interface FileTemplateEngineOptions {
  /**
   * The directory of the `.html` (and `.txt`) templates, with partials in its `partials/`
   * folder. A relative path is resolved against `process.cwd()`; build it from
   * `import.meta.dirname` to find the templates wherever the application is started.
   */
  dir: string;
  /** The template that wraps every mail's HTML (a header, a footer), placing it with `{{{ body }}}`. */
  layout?: string;
  /**
   * Keep compiled templates, and which files exist, in memory. Default `true`. Turn it off in
   * development to see edits without a restart.
   */
  cache?: boolean;
}
