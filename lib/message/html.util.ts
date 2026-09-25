const SAFE_HTML = Symbol.for('@nestjs/mail:safe-html');

/**
 * HTML that is safe to embed as is: built by the `html` template (which escaped every
 * interpolated value) or explicitly marked with `unsafeHtml()`. Its string value is in
 * `value`; `String(safeHtml)` gives the same.
 */
export interface SafeHtml {
  readonly value: string;
  readonly [SAFE_HTML]: true;
  toString(): string;
}

function safe(value: string): SafeHtml {
  return Object.freeze({ value, [SAFE_HTML]: true as const, toString: () => value });
}

export function isSafeHtml(value: unknown): value is SafeHtml {
  return typeof value === 'object' && value !== null && (value as SafeHtml)[SAFE_HTML] === true;
}

/** Values the `html` template accepts. Anything else is converted with `String()` and escaped. */
export type HtmlValue = SafeHtml | string | number | bigint | boolean | null | undefined | readonly HtmlValue[];

/** What follows a `<` that opens a tag, an end tag, a comment or a declaration. */
const TAG_START = /[A-Za-z/!?]/;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes `& < > " '`, which makes text safe in element content and in quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * An auto-escaping template tag. Every interpolated value is escaped unless it is
 * `SafeHtml` itself (a nested `html` template, or `unsafeHtml()`); arrays are
 * rendered item by item; `null`, `undefined` and `false` render nothing, so
 * `${order.gift && html`...`}` works.
 *
 * ```ts
 * html`<p>Hello ${user.name}</p><ul>${items.map((item) => html`<li>${item.title}</li>`)}</ul>`
 * ```
 *
 * Escaping protects element content and *quoted* attribute values, so those are the
 * only places a value may go. An interpolation inside a tag but outside quotes throws:
 * right after `=` (`<a href=${url}>`, where a space in the value would start a new
 * attribute) or between attributes (`<a ${attrs}>`, where escaping doesn't stop
 * `onclick=x` from becoming an attribute). Attributes built at runtime go through a
 * nested `html` template or `unsafeHtml()`. Escaping can't make a URL safe: check that
 * links built from user input are `https:` URLs.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    if (htmlContext(out) === 'tag' && !isSafeHtml(values[i])) {
      throw new TypeError(
        /=\s*$/.test(strings[i])
          ? `html: quote the attribute value that interpolation #${i + 1} goes into ` +
            `(write attr="\${value}", not attr=\${value})`
          : `html: interpolation #${i + 1} is inside a tag but not in a quoted attribute value, ` +
            'where escaping cannot protect it (build attributes with a nested html template or unsafeHtml())',
      );
    }

    out += render(values[i]) + strings[i + 1];
  }

  return safe(out);
}

/**
 * Where the next value lands: element content (a comment counts), a tag between its
 * attributes, or a quoted attribute value. Escaped values never contain `<`, `>` or a
 * quote, so only the template's own text and trusted `SafeHtml` values decide. Template
 * files are checked the same way, on their text without the tags.
 */
export function htmlContext(out: string): 'text' | 'tag' | 'quoted' {
  // The last `<` that opens a tag (a bare `<` in text, as in `a < b`, doesn't)
  let open = out.lastIndexOf('<');
  while (open > 0 && !TAG_START.test(out[open + 1] ?? '')) {
    open = out.lastIndexOf('<', open - 1);
  }
  if (open === -1 || !TAG_START.test(out[open + 1] ?? '')) {
    return 'text';
  }

  const tail = out.slice(open);
  if (tail.startsWith('<!--')) {
    return 'text';
  }

  let quote: string | undefined;
  for (const c of tail) {
    if (quote) {
      if (c === quote) {
        quote = undefined;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return 'text';
    }
  }
  return quote ? 'quoted' : 'tag';
}

/**
 * Marks a string as trusted HTML: it is embedded without escaping. For HTML you
 * produced yourself, such as a sanitized rich-text field or a rendered partial.
 * Never pass user input.
 */
export function unsafeHtml(value: string): SafeHtml {
  if (typeof value !== 'string') {
    throw new TypeError('unsafeHtml() takes a string');
  }
  return safe(value);
}

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) {
    return '';
  }
  if (isSafeHtml(value)) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map(render).join('');
  }
  return escapeHtml(String(value));
}
