import { MailMessageError } from '../errors/mail-message.error.js';
import type { MailAddress } from '../interfaces/mail-message.interface.js';

/** Soft limit for a header line (RFC 5322 §2.1.1), and the hard one. */
const SOFT_LIMIT = 78;
const HARD_LIMIT = 998;
/** An encoded-word is at most 75 characters (RFC 2047 §2). */
const MAX_ENCODED_WORD = 75;
const B_PREFIX = '=?UTF-8?B?';
const Q_PREFIX = '=?UTF-8?Q?';

/** RFC 5322 `ftext`: printable ASCII except the colon. */
const FIELD_NAME = /^[!-9;-~]+$/;
/** CR, LF and NUL: the characters that could end a header or smuggle a new one. Plus other controls. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_IN_VALUE = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;

/** Throws when a header value could break out of its line. */
export function checkHeaderValue(value: string, field: string): string {
  if (typeof value !== 'string') {
    throw new MailMessageError(field, 'must be a string');
  }
  if (FORBIDDEN_IN_VALUE.test(value)) {
    throw new MailMessageError(field, 'contains a line break or another control character');
  }
  return value;
}

export function checkHeaderName(name: string, field: string): string {
  if (!FIELD_NAME.test(name) || name.length > 76) {
    throw new MailMessageError(field, 'is not a valid header name (printable ASCII without ":" or spaces)');
  }
  return name;
}

/**
 * Unstructured text (Subject, custom headers): as is when it is printable ASCII, else
 * RFC 2047 encoded-words. Text that already looks like an encoded-word is encoded too,
 * so a subject from user input can't make mail clients decode something else.
 */
export function encodeText(value: string, headerName = ''): string[] {
  if (/^[\x20-\x7e\t]*$/.test(value) && !/=\?[^?]*\?[bBqQ]\?/.test(value)) {
    const words = value.split(/(?<=\S)(?=[ \t])/); // keep each word's leading whitespace
    if (words.every((word) => word.length <= 900)) {
      return words;
    }
  }
  return encodeWords(value, headerName.length + 2);
}

/** A display name: an atom sequence as is, a quoted-string for ASCII with specials, else encoded-words. */
export function encodePhrase(name: string, firstLineUsed = 0): string[] {
  if (/^[\x20-\x7e]*$/.test(name) && !/=\?/.test(name)) {
    const words = name.split(' ').filter(Boolean);
    if (words.every((word) => ATOM.test(word))) {
      return words.map((w, i) => (i ? ` ${w}` : w));
    }
    return [`"${name.replace(/(["\\])/g, '\\$1')}"`];
  }
  return encodeWords(name, firstLineUsed);
}

/**
 * Splits `value` into encoded-words of at most 75 characters, B or Q, whichever is
 * shorter, never splitting a character's UTF-8 bytes across two words (RFC 2047 §5).
 * Returned with a leading space on every word after the first: whitespace between
 * adjacent encoded-words is ignored when decoding. `firstLineUsed` is how much of the
 * first line the header name already takes (`Subject: `), so that line fits in 78 too.
 */
export function encodeWords(value: string, firstLineUsed = 0): string[] {
  const chars = Array.from(value);
  const first = Math.min(MAX_ENCODED_WORD, SOFT_LIMIT - firstLineUsed);
  const q = pack(chars, Q_PREFIX, (c) => qEncode(c).length, first);
  const b = pack(chars, B_PREFIX, null, first);
  const words = q.join('').length <= b.join('').length ? q : b;
  return words.map((word, i) => (i ? ` ${word}` : word));
}

function pack(chars: string[], prefix: string, qLength: ((c: string) => number) | null, first: number): string[] {
  const words: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = () => {
    if (!current.length) {
      return;
    }
    const text = current.join('');
    const payload = qLength ? current.map(qEncode).join('') : Buffer.from(text).toString('base64');
    words.push(`${prefix}${payload}?=`);
    current = [];
    size = 0;
  };

  for (const c of chars) {
    const budget = (words.length ? MAX_ENCODED_WORD : first) - prefix.length - 2;
    // B: 4 base64 characters per 3 bytes, so a 75-character word holds at most 45 bytes of text
    const next = qLength ? size + qLength(c) : Buffer.byteLength(current.join('') + c);
    const fits = qLength ? next <= budget : Math.ceil(next / 3) * 4 <= budget;
    if (!fits) {
      flush();
    }
    current.push(c);
    size = qLength ? size + qLength(c) : 0;
  }

  flush();
  return words;
}

/**
 * Q encoding of one character. Only letters, digits and `!*+-/` stay literal: that is
 * the set RFC 2047 §5(3) allows inside a phrase, and it is safe in unstructured text too.
 * A space becomes `_`.
 */
function qEncode(char: string): string {
  if (char === ' ') {
    return '_';
  }
  if (/^[A-Za-z0-9!*+\-/]$/.test(char)) {
    return char;
  }
  return Array.from(Buffer.from(char))
    .map((byte) => `=${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('');
}

/** `Name <address>`, the name encoded as a phrase; a bare address without one. */
export function addressTokens(address: MailAddress, firstLineUsed = 0): string[] {
  if (!address.name) {
    return [address.address];
  }
  return [...encodePhrase(address.name, firstLineUsed), ` <${address.address}>`];
}

/**
 * `Name: value` folded to 78-character lines at the whitespace the tokens carry.
 * `tokens` are pieces that may be separated by a line break (each piece after the
 * first starts with its whitespace). A piece that can't fit in 998 characters throws.
 */
export function foldHeader(name: string, tokens: readonly string[]): string {
  const lines: string[] = [];
  let line = `${name}:`;

  tokens.forEach((token, i) => {
    const piece = i === 0 && !/^[ \t]/.test(token) ? ` ${token}` : token;
    // Only whitespace is a fold point: a piece without it continues the current line.
    if (/^[ \t]/.test(piece) && line.length + piece.length > SOFT_LIMIT && line !== `${name}:`) {
      lines.push(line);
      line = piece;
    } else {
      line += piece;
    }
    if (line.length > HARD_LIMIT) {
      throw new MailMessageError(`headers.${name}`, `has a word longer than ${HARD_LIMIT - 2} characters`);
    }
  });

  lines.push(line);
  return lines.join('\r\n');
}

/** An address list header: `To: a <x@y>, b <z@w>`, folded between and inside addresses. */
export function addressHeader(name: string, addresses: readonly MailAddress[]): string {
  const tokens: string[] = [];
  addresses.forEach((address, i) => {
    const pieces = addressTokens(address, i ? 0 : name.length + 2);
    if (i < addresses.length - 1) {
      pieces[pieces.length - 1] += ',';
    }
    pieces[0] = i ? ` ${pieces[0].replace(/^ /, '')}` : pieces[0];
    tokens.push(...pieces);
  });

  return foldHeader(name, tokens);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 §3.3 date-time, in UTC: `Tue, 22 Sep 2026 18:04:05 +0000`. */
export function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

/**
 * A MIME parameter (RFC 2045 §5.1): `name="value"` for short ASCII values, else RFC 2231
 * extended notation with continuations: `name*0*=UTF-8''...; name*1*=...`.
 */
export function mimeParameter(name: string, value: string): string[] {
  if (/^[\x20-\x7e]*$/.test(value) && value.length + name.length < 60) {
    return [`${name}="${value.replace(/(["\\])/g, '\\$1')}"`];
  }

  const encoded = Array.from(value).map((c) =>
    /^[A-Za-z0-9!#$&+\-.^_`|~]$/.test(c)
      ? c
      : Array.from(Buffer.from(c))
          .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
          .join(''),
  );

  const segments: string[] = [];
  let current = "UTF-8''";
  for (const piece of encoded) {
    if (current.length + piece.length > 60) {
      segments.push(current);
      current = '';
    }
    current += piece;
  }
  segments.push(current);

  if (segments.length === 1) {
    return [`${name}*=${segments[0]}`];
  }
  return segments.map((segment, i) => `${name}*${i}*=${segment}`);
}
