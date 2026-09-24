/**
 * Content transfer encodings (RFC 2045 §6). Every output line ends with CRLF and stays
 * within 76 characters, so no server rewraps the message and a DKIM signature survives.
 */

/** Every line break (`\r\n`, a bare `\n`, a bare `\r`) becomes CRLF. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n');
}

/** Base64 in lines of 76 characters. */
export function base64Lines(content: Buffer): string {
  const encoded = content.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) {
    lines.push(encoded.slice(i, i + 76));
  }
  return lines.join('\r\n');
}

/**
 * Quoted-printable (RFC 2045 §6.7). Line breaks in the text are hard breaks (CRLF);
 * longer lines get soft breaks (`=` at the end) so no line exceeds 76 characters, and an
 * escape sequence is never split. Trailing spaces and tabs are encoded, since transports
 * may strip them. A `.` that would start a line is encoded too, so the SMTP layer never
 * has to dot-stuff a body (and a naive relay can't truncate it).
 */
export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of normalizeNewlines(text).split('\r\n')) {
    const bytes = Buffer.from(line, 'utf8');
    let current = '';
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      const last = i === bytes.length - 1;
      let piece: string;
      if (
        (byte >= 33 && byte <= 126 && byte !== 61 && !(byte === 46 && current === '')) ||
        ((byte === 32 || byte === 9) && !last)
      ) {
        piece = String.fromCharCode(byte);
      } else {
        piece = `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }

      // Leave room for the soft break's `=` (the last piece of the line needs none)
      const limit = last ? 76 : 75;
      if (current.length + piece.length > limit) {
        out.push(`${current}=`);
        current = '';
        if (piece === '.') {
          piece = '=2E';
        }
      }
      current += piece;
    }
    out.push(current);
  }

  return out.join('\r\n');
}

/**
 * Picks the body encoding for a text part: `7bit` when every line is short ASCII that
 * can't be mistaken for a multipart boundary (they all contain `=_`, which
 * quoted-printable and base64 never produce) or end the SMTP data early, otherwise
 * quoted-printable.
 */
export function encodeTextBody(text: string): { encoding: '7bit' | 'quoted-printable'; body: string } {
  const normalized = normalizeNewlines(text);
  const lines = normalized.split('\r\n');
  const plain =
    /^[\x20-\x7e\r\n\t]*$/.test(normalized) &&
    !normalized.includes('=_') &&
    lines.every((line) => line.length <= 76 && !line.startsWith('.') && !/[ \t]$/.test(line));

  if (plain) {
    return { encoding: '7bit', body: normalized };
  }
  return { encoding: 'quoted-printable', body: quotedPrintable(text) };
}
