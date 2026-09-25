const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  euro: '€',
  pound: '£',
  times: '×',
  zwnj: '',
  zwj: '',
};

/** Decodes numeric character references and the common named entities. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const BLOCK_END = /<\/(p|div|h[1-6]|table|ul|ol|blockquote|section|article|header|footer)\s*>/gi;
const ATTRIBUTE = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');

/**
 * A plain-text version of an HTML body, for the `text/plain` alternative when a mail
 * has none: paragraphs and headings become blank-line separated blocks, list items get a
 * `- ` bullet, table cells are separated by spaces, and links keep their target:
 * `Track your order (https://shop.example.com/orders/42)`.
 */
export function htmlToText(source: string): string {
  let text = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\s+/g, ' ');

  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attributes: string, label: string) => {
    const href = attributeValue(attributes, 'href');
    const inner = stripTags(label).trim();
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) {
      return inner;
    }
    const target = href.replace(/^mailto:/i, '');
    return !inner || inner === target || inner === href ? target : `${inner} (${target})`;
  });

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n\n----\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(BLOCK_END, '\n\n')
    .replace(/<(p|div|h[1-6]|table|ul|ol|blockquote)\b[^>]*>/gi, (tag) => (/^<div/i.test(tag) ? '\n' : '\n\n'));

  text = decodeEntities(stripTags(text));
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function attributeValue(attributes: string, name: string): string | undefined {
  const match = ATTRIBUTE(name).exec(` ${attributes}`);
  if (!match) {
    return undefined;
  }
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
}

/**
 * The links in a mail, in order and without duplicates: every `href` in the HTML
 * (entities decoded, so `&amp;` in a query string is `&` again), then URLs in the text
 * part that the HTML didn't have. `#fragment`, `cid:` and `mailto:` targets are skipped.
 */
export function extractLinks(htmlBody: string | undefined, textBody: string | undefined): string[] {
  const links: string[] = [];
  const add = (link: string) => {
    if (link && !links.includes(link)) {
      links.push(link);
    }
  };

  if (htmlBody) {
    const body = htmlBody.replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of body.matchAll(/<(?:a|area)\b([^>]*)>/gi)) {
      const href = attributeValue(tag[1], 'href');
      if (href && !/^(#|cid:|mailto:|javascript:)/i.test(href)) {
        add(href);
      }
    }
  }

  if (textBody) {
    for (const match of textBody.matchAll(/\bhttps?:\/\/[^\s<>"'()[\]]+/gi)) {
      add(match[0].replace(/[.,;:!?]+$/, ''));
    }
  }

  return links;
}
