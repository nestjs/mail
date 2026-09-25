import { MailTemplateError } from '../errors/mail-template.error.js';
import { escapeHtml, htmlContext, isSafeHtml } from '../message/html.util.js';

/** `html` templates escape the values they insert and check where they go; `text` templates insert them as they are. */
export type TemplateKind = 'html' | 'text';

/** Letters, digits, `-` and `_`, in folders separated by `/`: never `..`, a leading `/` or an extension. */
export const TEMPLATE_NAME = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

/** A template that includes itself, directly or through others, stops here instead of overflowing the stack. */
const MAX_PARTIAL_DEPTH = 32;

const BLOCKS = new Set(['if', 'unless', 'each']);
const DATA = new Set(['index', 'first', 'last', 'key']);
const SEGMENT = /^[A-Za-z0-9_$-]+$/;

export interface TemplatePosition {
  line: number;
  column: number;
}

interface Path {
  /** As written, for messages. */
  source: string;
  /** `@index`, `@first`, `@last` or `@key`. */
  data?: string;
  /** `@root.x`: from the outermost context. */
  root?: boolean;
  /** How many `../` precede it. */
  up: number;
  /** Written with `this`, `./` or `../`: looked up in that context only, never in outer ones. */
  scoped: boolean;
  parts: string[];
}

type TemplateNode =
  | { type: 'text'; value: string }
  | { type: 'value'; path: Path; raw: boolean; at: TemplatePosition }
  | { type: 'if'; path: Path; negate: boolean; body: TemplateNode[]; otherwise: TemplateNode[] }
  | { type: 'each'; path: Path; body: TemplateNode[]; otherwise: TemplateNode[] }
  | { type: 'partial'; name: string; indent: string; at: TemplatePosition };

/** A parsed template file, ready to render any number of times. */
export interface CompiledTemplate {
  /** The absolute path of the file. */
  readonly file: string;
  /** The file's path relative to the templates directory, as messages show it. */
  readonly shownAs: string;
  readonly kind: TemplateKind;
  readonly nodes: readonly TemplateNode[];
  /** The partials it includes, and where, so they are loaded before it renders. */
  readonly partials: readonly { name: string; at: TemplatePosition }[];
}

type TagKind = 'value' | 'raw' | 'comment' | 'open' | 'close' | 'else' | 'partial';

type Token =
  | { type: 'text'; value: string }
  | { type: 'tag'; kind: TagKind; body: string; start: number; indent?: string };

interface Frame {
  /** The contexts, outermost first: the template's, then one per `#each` item. */
  scopes: unknown[];
  data?: { index: number; first: boolean; last: boolean; key: string | number };
}

/**
 * Parses a template in the Handlebars subset: `{{ value }}` (escaped in HTML), `{{{ raw }}}`,
 * `#if`, `#unless` and `#each` blocks with `{{else}}`, `{{> partial}}` and comments. Throws
 * `MailTemplateError` with the line and column of the first problem.
 */
export function compileTemplate(
  source: string,
  file: { path: string; shownAs: string; kind: TemplateKind },
): CompiledTemplate {
  const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
  const at = positions(text);
  const fail = (offset: number, problem: string): never => {
    throw new MailTemplateError(problem, { file: file.path, shownAs: file.shownAs, ...at(offset) });
  };

  const nodes: TemplateNode[] = [];
  const partials: { name: string; at: TemplatePosition }[] = [];
  const open: {
    name: string;
    tag: string;
    start: number;
    node: Extract<TemplateNode, { type: 'if' | 'each' }>;
    inElse: boolean;
  }[] = [];
  const target = (): TemplateNode[] => {
    const block = open.at(-1);
    if (!block) {
      return nodes;
    }
    return block.inElse ? block.node.otherwise : block.node.body;
  };
  const describe = (start: number) => {
    const { line, column } = at(start);
    return `${line}:${column}`;
  };

  // The template's own text so far, in source order: where an escaped value lands depends
  // only on it, since escaped values contain no `<`, `>` or quotes
  let literal = '';

  for (const token of tokenize(text, fail)) {
    if (token.type === 'text') {
      if (token.value) {
        target().push({ type: 'text', value: token.value });
        literal += token.value;
      }
      continue;
    }

    const { kind, body, start } = token;
    switch (kind) {
      case 'comment':
        break;

      case 'value':
      case 'raw': {
        const path = parsePath(body, start, fail);
        if (kind === 'value' && file.kind === 'html' && htmlContext(literal) === 'tag') {
          fail(
            start,
            /=\s*$/.test(literal)
              ? `quote the attribute value {{ ${body} }} goes into (write attr="{{ ${body} }}")`
              : `{{ ${body} }} is inside a tag but not in a quoted attribute value, where escaping can't protect it`,
          );
        }
        target().push({ type: 'value', path, raw: kind === 'raw', at: at(start) });
        break;
      }

      case 'open': {
        const [name, ...args] = body.split(/\s+/);
        if (!BLOCKS.has(name)) {
          fail(start, `unknown block helper {{#${body}}}: the blocks are #if, #unless and #each`);
        }
        const node = block(name, args, start, fail);
        target().push(node);
        open.push({ name, tag: `{{#${body}}}`, start, node, inElse: false });
        break;
      }

      case 'else': {
        const current = open.at(-1);
        if (!current) {
          fail(start, '{{else}} outside of a block');
        } else if (current.inElse) {
          fail(start, `a second {{else}} in ${current.tag}, opened at ${describe(current.start)}`);
        } else if (!body) {
          current.inElse = true;
        } else {
          // `{{else if x}}` chains a block into the else branch; the first block's `{{/if}}` closes both
          const [name, ...args] = body.split(/\s+/);
          if (name !== 'if' && name !== 'unless') {
            fail(start, `unknown syntax {{else ${body}}}: else is followed by nothing, if or unless`);
          }
          const node = block(name, args, start, fail);
          current.node.otherwise.push(node);
          current.node = node;
        }
        break;
      }

      case 'close': {
        const current = open.pop();
        if (!current) {
          fail(start, `{{/${body}}} doesn't close any block`);
        } else if (body !== current.name) {
          fail(start, `{{/${body}}} closes ${current.tag}, opened at ${describe(current.start)}`);
        }
        break;
      }

      case 'partial': {
        const [name, ...args] = body.split(/\s+/);
        if (args.length) {
          fail(start, `{{> ${body}}}: a partial takes no arguments, it reads the context it is included in`);
        }
        if (!TEMPLATE_NAME.test(name)) {
          fail(start, `invalid partial name {{> ${body}}}: use letters, digits, "-" and "_", with "/" between folders`);
        }
        target().push({ type: 'partial', name, indent: token.indent ?? '', at: at(start) });
        partials.push({ name, at: at(start) });
        break;
      }
    }
  }

  const unclosed = open.at(-1);
  if (unclosed) {
    fail(unclosed.start, `${unclosed.tag} is never closed (expected {{/${unclosed.name}}})`);
  }

  return { file: file.path, shownAs: file.shownAs, kind: file.kind, nodes, partials };
}

/** Renders a compiled template with `context`. `partials` holds every partial it (and they) include. */
export function renderTemplate(
  template: CompiledTemplate,
  context: unknown,
  partials: ReadonlyMap<string, CompiledTemplate>,
): string {
  return renderNodes(template, template.nodes, { scopes: [context] }, partials, 0);
}

function renderNodes(
  template: CompiledTemplate,
  nodes: readonly TemplateNode[],
  frame: Frame,
  partials: ReadonlyMap<string, CompiledTemplate>,
  depth: number,
): string {
  let out = '';

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += node.value;
        break;

      case 'value':
        out += display(template, node, lookup(node.path, frame));
        break;

      case 'if': {
        const truthy = !isEmpty(lookup(node.path, frame));
        out += renderNodes(template, truthy !== node.negate ? node.body : node.otherwise, frame, partials, depth);
        break;
      }

      case 'each': {
        const items = entries(lookup(node.path, frame));
        if (!items.length) {
          out += renderNodes(template, node.otherwise, frame, partials, depth);
          break;
        }

        items.forEach(([key, item], index) => {
          const data = { index, key, first: index === 0, last: index === items.length - 1 };
          out += renderNodes(template, node.body, { scopes: [...frame.scopes, item], data }, partials, depth);
        });
        break;
      }

      case 'partial': {
        const partial = partials.get(node.name);
        if (!partial || depth >= MAX_PARTIAL_DEPTH) {
          throw new MailTemplateError(
            partial
              ? `partials are nested more than ${MAX_PARTIAL_DEPTH} deep here: does {{> ${node.name}}} include itself?`
              : `the partial {{> ${node.name}}} wasn't loaded`,
            { file: template.file, shownAs: template.shownAs, ...node.at },
          );
        }

        const result = renderNodes(partial, partial.nodes, frame, partials, depth + 1);
        out += node.indent ? indent(result, node.indent) : result;
        break;
      }
    }
  }

  return out;
}

function tokenize(source: string, fail: (offset: number, problem: string) => never): Token[] {
  const tokens: Token[] = [];
  let text = '';
  let i = 0;

  while (i < source.length) {
    const start = source.indexOf('{{', i);
    if (start === -1) {
      text += source.slice(i);
      break;
    }

    // `\{{` is a literal `{{`, as in Handlebars
    if (source[start - 1] === '\\') {
      text += `${source.slice(i, start - 1)}{{`;
      i = start + 2;
      continue;
    }

    text += source.slice(i, start);
    if (text) {
      tokens.push({ type: 'text', value: text });
      text = '';
    }

    const [kind, body, end] = readTag(source, start, fail);
    tokens.push({ type: 'tag', kind, body, start });
    i = end;
  }

  if (text) {
    tokens.push({ type: 'text', value: text });
  }
  return standalone(tokens);
}

function readTag(
  source: string,
  start: number,
  fail: (offset: number, problem: string) => never,
): [TagKind, string, number] {
  const closing = (open: string, close: string) => {
    const end = source.indexOf(close, start + open.length);
    if (end === -1) {
      fail(start, `${open} is never closed (expected ${close})`);
    }
    return [source.slice(start + open.length, end).trim(), end + close.length] as const;
  };

  if (source.startsWith('{{{', start)) {
    const [body, end] = closing('{{{', '}}}');
    return ['raw', body, end];
  }
  if (source.startsWith('{{!--', start)) {
    const [, end] = closing('{{!--', '--}}');
    return ['comment', '', end];
  }

  const [inner, end] = closing('{{', '}}');
  if (inner.startsWith('!')) {
    return ['comment', '', end];
  }
  if (inner.startsWith('~') || inner.endsWith('~')) {
    fail(start, `whitespace control (~) isn't supported: {{${inner}}}`);
  }

  const rest = inner.slice(1).trim();
  switch (inner[0]) {
    case '#':
      return ['open', rest, end];
    case '/':
      return ['close', rest, end];
    case '>':
      return ['partial', rest, end];
  }
  if (inner === 'else' || /^else\s/.test(inner)) {
    return ['else', inner.slice(4).trim(), end];
  }
  return ['value', inner, end];
}

/**
 * A block tag, `{{else}}`, a comment or a partial alone on its line takes the whole line
 * with it, as in Handlebars, so blocks can sit on lines of their own in a `.txt` template.
 * A standalone partial indents every line it renders like the tag.
 */
function standalone(tokens: Token[]): Token[] {
  const strips: { token: Extract<Token, { type: 'tag' }>; before?: Token; after?: Token; indent: string; newline: number }[] = [];

  tokens.forEach((token, i) => {
    if (token.type !== 'tag' || token.kind === 'value' || token.kind === 'raw') {
      return;
    }

    const before = tokens[i - 1];
    const after = tokens[i + 1];
    let indent: string | undefined;
    if (!before) {
      indent = '';
    } else if (before.type === 'text') {
      const newline = before.value.lastIndexOf('\n');
      const tail = before.value.slice(newline + 1);
      if (/^[ \t]*$/.test(tail) && (newline !== -1 || i === 1)) {
        indent = tail;
      }
    }
    if (indent === undefined || (after && after.type !== 'text')) {
      return;
    }

    // Only whitespace up to the end of the line, or up to the end of the template
    const rest = after ? /^[ \t]*(\r?\n|$)/.exec(after.value) : [''];
    const atEnd = !after || i + 1 === tokens.length - 1;
    if (!rest || (!rest[0].endsWith('\n') && !atEnd)) {
      return;
    }
    strips.push({ token, before, after, indent, newline: rest[0].length });
  });

  for (const { token, before, after, indent, newline } of strips) {
    if (before?.type === 'text') {
      before.value = before.value.slice(0, before.value.length - indent.length);
    }
    if (after?.type === 'text') {
      after.value = after.value.slice(newline);
    }
    token.indent = indent;
  }

  return tokens;
}

function block(
  name: string,
  args: string[],
  start: number,
  fail: (offset: number, problem: string) => never,
): Extract<TemplateNode, { type: 'if' | 'each' }> {
  if (!args.length || !args[0]) {
    fail(start, `{{#${name}}} needs a value, as in {{#${name} items}}`);
  }
  if (args.length > 1) {
    fail(
      start,
      args[1] === 'as'
        ? `block parameters (as |item|) aren't supported: inside {{#each}}, the item is this`
        : `{{#${name} ${args.join(' ')}}} takes one value: helpers and hash arguments aren't supported`,
    );
  }

  const path = parsePath(args[0], start, fail);
  return name === 'each'
    ? { type: 'each', path, body: [], otherwise: [] }
    : { type: 'if', path, negate: name === 'unless', body: [], otherwise: [] };
}

function parsePath(source: string, start: number, fail: (offset: number, problem: string) => never): Path {
  const invalid = () =>
    fail(
      start,
      /\s/.test(source)
        ? `helpers aren't supported ({{ ${source} }}): prepare the value in the mail class`
        : `unknown syntax {{ ${source} }}`,
    );
  const segments = (rest: string) => {
    const parts = rest.split(/[./]/);
    if (!parts.every((part) => SEGMENT.test(part) && part !== 'this')) {
      invalid();
    }
    return parts;
  };

  if (source.startsWith('@')) {
    const [name, ...rest] = source.slice(1).split(/[./]/);
    if (name === 'root') {
      return { source, root: true, up: 0, scoped: true, parts: rest.length ? segments(rest.join('.')) : [] };
    }
    if (!DATA.has(name) || rest.length) {
      fail(start, `unknown data variable ${source}: there are @index, @first, @last, @key and @root`);
    }
    return { source, data: name, up: 0, scoped: true, parts: [] };
  }

  let rest = source;
  let up = 0;
  while (rest.startsWith('../')) {
    up++;
    rest = rest.slice(3);
  }
  if (rest === '..') {
    up++;
    rest = '';
  }

  let scoped = up > 0;
  if (rest === 'this' || rest === '.') {
    rest = '';
    scoped = true;
  } else if (rest.startsWith('./')) {
    rest = rest.slice(2);
    scoped = true;
  } else if (/^this[./]/.test(rest)) {
    rest = rest.slice(5);
    scoped = true;
  }

  if (!rest) {
    if (!scoped) {
      invalid();
    }
    return { source, up, scoped, parts: [] };
  }
  return { source, up, scoped, parts: segments(rest) };
}

/**
 * Own properties only, as Handlebars allows by default: a template can't reach
 * `constructor` or anything else on a prototype. Functions aren't called.
 */
function get(target: unknown, key: string): unknown {
  if (target === null || target === undefined || !Object.hasOwn(Object(target), key)) {
    return undefined;
  }
  const value = (target as Record<string, unknown>)[key];
  return typeof value === 'function' ? undefined : value;
}

/**
 * A plain path looks in the innermost context first, then in the outer ones (as with
 * Handlebars' `compat` option), so `{{ currency }}` inside `{{#each items}}` finds the
 * template's `currency`. `this.x`, `./x` and `../x` look in one context only.
 */
function lookup(path: Path, frame: Frame): unknown {
  if (path.data) {
    return frame.data?.[path.data as keyof NonNullable<Frame['data']>];
  }

  const { scopes } = frame;
  let parts = path.parts;
  let value: unknown;
  if (path.root) {
    value = scopes[0];
  } else if (path.scoped) {
    value = scopes[scopes.length - 1 - path.up];
  } else {
    for (let i = scopes.length - 1; i >= 0 && value == null; i--) {
      value = get(scopes[i], parts[0]);
    }
    parts = parts.slice(1);
  }

  for (const part of parts) {
    value = get(value, part);
  }
  return value;
}

/** Handlebars' truthiness: an empty array is false, and so is 0. */
function isEmpty(value: unknown): boolean {
  return !value || (Array.isArray(value) && value.length === 0);
}

function entries(value: unknown): [string | number, unknown][] {
  if (Array.isArray(value)) {
    return value.map((item, i) => [i, item]);
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  if (Symbol.iterator in value) {
    return Array.from(value as Iterable<unknown>, (item, i) => [i, item]);
  }
  return Object.keys(value).map((key) => [key, (value as Record<string, unknown>)[key]]);
}

function display(template: CompiledTemplate, node: Extract<TemplateNode, { type: 'value' }>, value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  // Like Handlebars' SafeString: HTML built with the html tag is inserted as it is
  if (isSafeHtml(value)) {
    return value.value;
  }

  let text: string;
  try {
    text = String(value);
  } catch (cause) {
    throw new MailTemplateError(`{{ ${node.path.source} }} can't be converted to text`, {
      file: template.file,
      shownAs: template.shownAs,
      ...node.at,
      cause,
    });
  }
  return template.kind === 'html' && !node.raw ? escapeHtml(text) : text;
}

function indent(text: string, prefix: string): string {
  const lines = text.split('\n');
  return lines.map((line, i) => (i === lines.length - 1 && !line ? line : prefix + line)).join('\n');
}

/** Line and column (both from 1) of an offset in `text`. */
function positions(text: string): (offset: number) => TemplatePosition {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    starts.push(i + 1);
  }

  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return { line: low + 1, column: offset - starts[low] + 1 };
  };
}
