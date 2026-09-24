/**
 * A small MIME parser for round-trip tests, written from the RFCs independently of the
 * builder (RFC 5322 unfolding, RFC 2047 encoded-words, RFC 2231 parameters, RFC 2045
 * quoted-printable and base64, RFC 2046 multipart). It is strict where the builder must
 * be: bare CR or LF and lines over 998 characters fail `lint()`.
 */
export interface ParsedPart {
  headers: [name: string, value: string][];
  type: string;
  params: Record<string, string>;
  /** Decoded body (after the transfer encoding). */
  body: Buffer;
  parts: ParsedPart[];
}

export function lint(raw: string): string[] {
  const problems: string[] = [];
  if (/\r(?!\n)|(?<!\r)\n/.test(raw)) {
    problems.push('bare CR or LF');
  }

  raw.split('\r\n').forEach((line, i) => {
    if (Buffer.byteLength(line) > 998) {
      problems.push(`line ${i + 1} is ${Buffer.byteLength(line)} bytes`);
    }
  });

  if (/\0/.test(raw)) {
    problems.push('NUL byte');
  }

  return problems;
}

export function parseMessage(raw: string): ParsedPart {
  const split = raw.indexOf('\r\n\r\n');
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? '' : raw.slice(split + 4);
  const headers = parseHeaders(head);
  const [type, params] = parseContentType(header(headers, 'content-type') ?? 'text/plain; charset=us-ascii');

  if (type.startsWith('multipart/')) {
    const boundary = params.boundary;
    if (!boundary) {
      throw new Error('multipart without boundary');
    }

    const delimiter = `--${boundary}`;
    const sections = body.split(`\r\n${delimiter}`);
    // The first section is the preamble (it starts with the delimiter when there is none)
    const first = sections[0].startsWith(delimiter) ? sections[0].slice(delimiter.length) : undefined;
    const rest = first === undefined ? sections.slice(1) : [first, ...sections.slice(1)];
    const parts: ParsedPart[] = [];
    let closed = false;

    for (const section of rest) {
      if (section.startsWith('--')) {
        closed = true;
        break;
      }
      parts.push(parseMessage(section.replace(/^[ \t]*\r\n/, '')));
    }

    if (!closed) {
      throw new Error(`multipart ${boundary} has no closing delimiter`);
    }

    return { headers, type, params, body: Buffer.alloc(0), parts };
  }

  const encoding = (header(headers, 'content-transfer-encoding') ?? '7bit').toLowerCase();
  return { headers, type, params, body: decodeBody(body, encoding), parts: [] };
}

export function header(headers: ParsedPart['headers'], name: string): string | undefined {
  return headers.find(([n]) => n.toLowerCase() === name)?.[1];
}

export function headerAll(headers: ParsedPart['headers'], name: string): string[] {
  return headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);
}

function parseHeaders(head: string): ParsedPart['headers'] {
  const unfolded = head.replace(/\r\n(?=[ \t])/g, '');
  return unfolded
    .split('\r\n')
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(':');
      if (colon <= 0 || !/^[!-9;-~]+$/.test(line.slice(0, colon))) {
        throw new Error(`bad header line: ${line}`);
      }
      return [line.slice(0, colon), line.slice(colon + 1).replace(/^[ \t]+/, '')];
    });
}

/** Decodes RFC 2047 encoded-words; whitespace between two adjacent ones is dropped. */
export function decodeWords(value: string): string {
  const word = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  return value
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)[ \t]+(?==\?[^?]+\?[bBqQ]\?[^?]*\?=)/g, '$1')
    .replace(word, (_m, charset: string, encoding: string, text: string) => {
      if (!/^utf-8$/i.test(charset)) {
        throw new Error(`unexpected charset ${charset}`);
      }
      const bytes =
        encoding.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/g, (_x, hex: string) => String.fromCharCode(parseInt(hex, 16))),
              'latin1',
            );
      return bytes.toString('utf8');
    });
}

export interface ParsedAddress {
  name?: string;
  address: string;
}

/** An address-list header: quoted names, encoded-word names, commas inside quotes. */
export function parseAddresses(value: string): ParsedAddress[] {
  const out: ParsedAddress[] = [];
  let current = '';
  let quoted = false;
  let angle = false;

  const flush = () => {
    const item = current.trim();
    current = '';
    if (!item) {
      return;
    }

    const match = /^(.*)<([^<>]+)>$/.exec(item);
    if (!match) {
      return out.push({ address: item });
    }

    let name = match[1].trim();
    if (name.startsWith('"')) {
      name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    } else {
      name = decodeWords(name);
    }
    out.push({ ...(name && { name }), address: match[2] });
  };

  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && quoted) {
      current += c + value[++i];
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
    }
    if (c === '<' && !quoted) {
      angle = true;
    }
    if (c === '>' && !quoted) {
      angle = false;
    }
    if (c === ',' && !quoted && !angle) {
      flush();
    } else {
      current += c;
    }
  }

  flush();
  return out;
}

/** `type/subtype; a=b; c*0*=utf-8''..; c*1*=..` with RFC 2231 continuations and charsets. */
export function parseContentType(value: string): [string, Record<string, string>] {
  const [type, ...rest] = splitParams(value);
  const params: Record<string, string> = {};
  const extended: Record<string, { index: number; value: string; encoded: boolean }[]> = {};

  for (const param of rest) {
    const eq = param.indexOf('=');
    const rawName = param.slice(0, eq).trim().toLowerCase();
    let raw = param.slice(eq + 1).trim();
    if (raw.startsWith('"')) {
      raw = raw.slice(1, -1).replace(/\\(.)/g, '$1');
    }

    const match = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(rawName)!;
    if (match[2] === undefined && !match[3]) {
      params[match[1]] = raw;
    } else {
      (extended[match[1]] ??= []).push({ index: Number(match[2] ?? 0), value: raw, encoded: Boolean(match[3]) });
    }
  }

  for (const [name, pieces] of Object.entries(extended)) {
    pieces.sort((a, b) => a.index - b.index);
    let charset = 'us-ascii';
    const bytes: number[] = [];
    pieces.forEach((piece, i) => {
      let text = piece.value;
      if (i === 0 && piece.encoded) {
        const [cs, , rest] = text.split("'");
        charset = cs;
        text = rest;
      }
      if (piece.encoded) {
        for (let j = 0; j < text.length; j++) {
          if (text[j] === '%') {
            bytes.push(parseInt(text.slice(j + 1, j + 3), 16));
            j += 2;
          } else {
            bytes.push(text.charCodeAt(j));
          }
        }
      } else {
        bytes.push(...Buffer.from(text, 'latin1'));
      }
    });
    if (!/^(utf-8|us-ascii)$/i.test(charset)) {
      throw new Error(`unexpected charset ${charset}`);
    }
    params[name] = Buffer.from(bytes).toString('utf8');
  }

  return [type.trim().toLowerCase(), params];
}

function splitParams(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && quoted) {
      current += c + value[++i];
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
    }
    if (c === ';' && !quoted) {
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }

  out.push(current);
  return out.filter((p) => p.trim());
}

function decodeBody(body: string, encoding: string): Buffer {
  if (encoding === 'base64') {
    if (!/^[A-Za-z0-9+/=\r\n]*$/.test(body)) {
      throw new Error('invalid base64 body');
    }
    return Buffer.from(body.replace(/\r\n/g, ''), 'base64');
  }

  if (encoding === 'quoted-printable') {
    for (const line of body.split('\r\n')) {
      if (line.length > 76) {
        throw new Error(`quoted-printable line of ${line.length} characters`);
      }
      if (/[ \t]$/.test(line)) {
        throw new Error('quoted-printable line with trailing whitespace');
      }
      if (/[^\t\x20-\x7e]/.test(line)) {
        throw new Error('quoted-printable line with a raw non-ASCII byte');
      }
    }

    const binary = body
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(binary, 'latin1');
  }

  if (encoding === '7bit' && /[^\x00-\x7f]/.test(body)) {
    throw new Error('8-bit data in a 7bit part');
  }
  return Buffer.from(body, 'utf8');
}

/** Every leaf part, depth first. */
export function leaves(part: ParsedPart): ParsedPart[] {
  return part.parts.length ? part.parts.flatMap(leaves) : [part];
}
