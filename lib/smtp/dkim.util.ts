import type { DkimOptions } from '../interfaces/smtp-transport-options.interface.js';
import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';

const DEFAULT_HEADERS = [
  'from',
  'reply-to',
  'to',
  'cc',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
];
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const SELECTOR = /^[a-z0-9](?:[a-z0-9-_]{0,61}[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-_]{0,61}[a-z0-9])?)*$/i;

export interface DkimSigner {
  (message: Buffer, now?: number): Buffer;
}

/** Validates the options once (at startup) and returns the signing function. */
export function createDkimSigner(options: DkimOptions, owner: string): DkimSigner {
  const { domainName, keySelector } = options;
  if (typeof domainName !== 'string' || !DOMAIN.test(domainName)) {
    throw new TypeError(`${owner} \`dkim.domainName\` must be a domain name`);
  }
  if (typeof keySelector !== 'string' || !SELECTOR.test(keySelector)) {
    throw new TypeError(`${owner} \`dkim.keySelector\` must be a DNS label such as "mail2026"`);
  }

  let key: KeyObject;
  try {
    key = typeof options.privateKey === 'object' && 'asymmetricKeyType' in options.privateKey
      ? options.privateKey
      : createPrivateKey(options.privateKey as string | Buffer);
  } catch {
    // The key itself never goes into a message
    throw new TypeError(`${owner} \`dkim.privateKey\` is not a valid PEM private key`);
  }
  if (key.type !== 'private') {
    throw new TypeError(`${owner} \`dkim.privateKey\` must be a private key`);
  }

  let algorithm: 'rsa-sha256' | 'ed25519-sha256';
  if (key.asymmetricKeyType === 'rsa') {
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 1024) {
      throw new TypeError(`${owner} \`dkim.privateKey\` is an RSA key shorter than 1024 bits; use 2048`);
    }
    algorithm = 'rsa-sha256';
  } else if (key.asymmetricKeyType === 'ed25519') {
    algorithm = 'ed25519-sha256';
  } else {
    throw new TypeError(`${owner} \`dkim.privateKey\` must be an RSA or Ed25519 key`);
  }

  const wanted = options.headers?.map((name) => name.toLowerCase());
  return (message, now = Date.now()) =>
    signMessage(message, { algorithm, key, domainName: domainName.toLowerCase(), keySelector, wanted, now });
}

function signMessage(
  message: Buffer,
  o: {
    algorithm: 'rsa-sha256' | 'ed25519-sha256';
    key: KeyObject;
    domainName: string;
    keySelector: string;
    wanted?: string[];
    now: number;
  },
): Buffer {
  const text = message.toString('utf8');
  const split = text.indexOf('\r\n\r\n');
  const head = split === -1 ? text : text.slice(0, split + 2);
  const body = split === -1 ? '' : text.slice(split + 4);
  const fields = parseHeaderFields(head);

  const present = fields.map((f) => f.name.toLowerCase());
  const custom = present.filter(
    (name) => !DEFAULT_HEADERS.includes(name) && !name.startsWith('content-') && name !== 'dkim-signature',
  );
  const candidates = o.wanted ?? [...DEFAULT_HEADERS, ...custom];
  const signed: string[] = [];
  for (const name of new Set(['from', ...candidates])) {
    const count = present.filter((p) => p === name).length;
    for (let i = 0; i < count; i++) {
      signed.push(name);
    }
  }
  signed.push('from'); // over-sign: an added From would break the signature

  const bh = createHash('sha256').update(relaxedBody(body), 'utf8').digest('base64');
  const tags = [
    'v=1',
    `a=${o.algorithm}`,
    'c=relaxed/relaxed',
    `d=${o.domainName}`,
    `s=${o.keySelector}`,
    `t=${Math.floor(o.now / 1000)}`,
    `h=${signed.join(':')}`,
    `bh=${bh}`,
    'b=',
  ];
  const unsigned = `DKIM-Signature: ${tags.join('; ')}`;
  const b = computeSignature(fields, signed, unsigned, o.algorithm, o.key);
  return Buffer.concat([Buffer.from(`${fold(unsigned, b)}\r\n`, 'utf8'), message]);
}

/**
 * The `b=` value: the signed header fields (picked from the bottom up, RFC 6376 §5.4.2)
 * and the DKIM-Signature field itself with an empty `b=`, relaxed-canonicalized.
 * Ed25519 signs the SHA-256 digest of that data (RFC 8463 §3).
 */
export function computeSignature(
  fields: HeaderField[],
  signed: string[],
  dkimHeader: string,
  algorithm: 'rsa-sha256' | 'ed25519-sha256',
  key: KeyObject,
): string {
  const used = new Map<string, number>();
  let data = '';
  for (const name of signed) {
    const matching = fields.filter((f) => f.name.toLowerCase() === name);
    const index = matching.length - 1 - (used.get(name) ?? 0);
    used.set(name, (used.get(name) ?? 0) + 1);
    if (index >= 0) {
      data += `${relaxedHeader(matching[index].raw)}\r\n`; // a missing one signs as empty
    }
  }

  data += relaxedHeader(dkimHeader.replace(/(\bb=)[^;]*$/, '$1'));
  const signature =
    algorithm === 'ed25519-sha256'
      ? sign(null, createHash('sha256').update(data, 'utf8').digest(), key)
      : sign('sha256', Buffer.from(data, 'utf8'), key);
  return signature.toString('base64');
}

export interface HeaderField {
  name: string;
  /** The whole field, continuation lines included, without the final CRLF. */
  raw: string;
}

export function parseHeaderFields(head: string): HeaderField[] {
  const fields: HeaderField[] = [];
  for (const line of head.split('\r\n')) {
    if (line === '') {
      continue;
    }
    if (/^[ \t]/.test(line) && fields.length) {
      fields[fields.length - 1].raw += `\r\n${line}`;
    } else {
      fields.push({ name: line.slice(0, line.indexOf(':')).trim(), raw: line });
    }
  }

  return fields;
}

/** RFC 6376 §3.4.2: lowercase name, unfold, collapse whitespace, trim around the colon. */
export function relaxedHeader(raw: string): string {
  const colon = raw.indexOf(':');
  const name = raw.slice(0, colon).trim().toLowerCase();
  const value = raw
    .slice(colon + 1)
    .replace(/\r\n/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return `${name}:${value}`;
}

/** RFC 6376 §3.4.4: collapse whitespace, strip it at line ends, drop trailing empty lines. */
export function relaxedBody(body: string): string {
  const lines = body.split('\r\n').map((line) => line.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length ? `${lines.join('\r\n')}\r\n` : '';
}

/** Folds between tags (replacing one space, so relaxed canonicalization is unchanged) and inside `b=`. */
function fold(unsigned: string, b: string): string {
  const parts = unsigned.split('; ');
  const lines: string[] = [];
  let line = '';

  for (const [i, part] of parts.entries()) {
    const piece = i < parts.length - 1 ? `${part};` : part;
    if (line && line.length + 1 + piece.length > 76) {
      lines.push(line);
      line = ` ${piece}`;
    } else {
      line = line ? `${line} ${piece}` : piece;
    }
  }

  // `b=` is last; its value may contain folding whitespace (a verifier removes it with the value)
  const chunks = b.match(/.{1,72}/g) ?? [''];
  line += chunks[0];
  lines.push(line, ...chunks.slice(1).map((chunk) => ` ${chunk}`));
  return lines.join('\r\n');
}
