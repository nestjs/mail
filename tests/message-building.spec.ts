import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { html, MailMessageError } from '../lib/index.js';
import { parseAddress, parseAddressList } from '../lib/message/address.util.js';
import { encodeTextBody, normalizeNewlines } from '../lib/message/encoding.util.js';
import {
  checkHeaderName,
  encodePhrase,
  encodeText,
  encodeWords,
  foldHeader,
  formatDate,
  mimeParameter,
} from '../lib/message/headers.util.js';
import { assertRecipients, createMailMessage, type MailDefaults, type NormalizeInput } from '../lib/message/normalize.util.js';
import { decodeWords, header, leaves, lint, parseContentType, parseMessage } from './support/mime-parser.js';

const FROM = 'Orders <orders@example.com>';

function build(input: Partial<NormalizeInput>, defaults: MailDefaults = { from: FROM }, now?: Date) {
  return createMailMessage({ subject: 'Hello', text: 'Hi', to: 'ada@example.com', ...input }, defaults, now);
}

async function parsed(input: Partial<NormalizeInput>) {
  const raw = (await build(input)).toMime().toString('utf8');
  expect(lint(raw)).toEqual([]);
  return parseMessage(raw);
}

describe('address parsing', () => {
  it('lowercases the domain but keeps the local part as given', () => {
    expect(parseAddress('Ada.Lovelace@EXAMPLE.Com', 'to')).toEqual({ address: 'Ada.Lovelace@example.com' });
  });

  it('accepts localhost as the only single-label domain', () => {
    expect(parseAddress('dev@localhost', 'to')).toEqual({ address: 'dev@localhost' });
  });

  it('collapses whitespace in an unquoted display name, and trims every name', () => {
    expect(parseAddress('  Ada    Lovelace   <ada@example.com>  ', 'to')).toEqual({ name: 'Ada Lovelace', address: 'ada@example.com' });
    expect(parseAddress({ name: '  Ada  ', address: ' ada@example.com ' }, 'to')).toEqual({ name: 'Ada', address: 'ada@example.com' });
  });

  it('treats an empty name, and an empty display name, as no name', () => {
    expect(parseAddress({ name: '', address: 'ada@example.com' }, 'to')).toEqual({ address: 'ada@example.com' });
    expect(parseAddress('  <ada@example.com>', 'to')).toEqual({ address: 'ada@example.com' });
  });

  it('keeps a "<" inside a quoted name out of the address', () => {
    expect(parseAddress('"a <b@evil.example>" <ada@example.com>', 'to')).toEqual({ name: 'a <b@evil.example>', address: 'ada@example.com' });
  });

  it.each([
    ['a local part over 64 bytes', `${'a'.repeat(65)}@example.com`, /local part longer than 64 bytes/],
    ['an address over 254 bytes', `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.eeeee.com`, /is longer than 254 bytes/],
    ['a domain over 253 characters', `a@${`${'b'.repeat(60)}.`.repeat(4)}example.com`, /invalid domain/],
    ['a label over 63 characters', `a@${'b'.repeat(64)}.example.com`, /invalid domain/],
    ['a doubled dot in the local part', 'ada..l@example.com', /invalid local part/],
    ['text after the quoted name', '"Ada" Lovelace <ada@example.com>', /text after the quoted display name/],
    ['a stray ">"', 'ada@example.com>', /has an unmatched ">"/],
    ['a tab', 'Ada\tLovelace <ada@example.com>', /control character/],
    ['a C1 control', 'Ada\u0085 <ada@example.com>', /control character/],
    ['an unquoted "@" in the name', 'ada@home <ada@example.com>', /special characters/],
  ])('refuses %s', (_case, input, message) => {
    expect(() => parseAddress(input, 'to')).toThrow(message);
  });

  it('refuses a name over 256 characters, and names of the wrong type', () => {
    expect(() => parseAddress({ name: 'n'.repeat(257), address: 'a@example.com' }, 'cc[2]')).toThrow('Invalid mail: cc[2].name is longer than 256 characters');
    expect(() => parseAddress({ name: 42 as never, address: 'a@example.com' }, 'to')).toThrow('Invalid mail: to.name must be a string');
    expect(() => parseAddress({ address: 42 } as never, 'to')).toThrow(/to must be a string or \{ name\?, address \}/);
    expect(() => parseAddress(42 as never, 'to')).toThrow(/to must be a string or/);
  });

  it('shortens a long refused address in the message', () => {
    const error = (() => {
      try {
        parseAddress(`${'x'.repeat(200)}@`, 'to');
      } catch (e) {
        return e as MailMessageError;
      }
    })()!;
    expect(error.message).toContain('…');
    expect(error.message.length).toBeLessThan(150);
  });

  it('reads a list: nothing, one address, or an array whose items are named by index', () => {
    expect(parseAddressList(undefined, 'to')).toEqual([]);
    expect(parseAddressList(null, 'to')).toEqual([]);
    expect(parseAddressList('a@example.com', 'to')).toEqual([{ address: 'a@example.com' }]);
    expect(() => parseAddressList(['a@example.com', 'nope'], 'bcc')).toThrow(expect.objectContaining({ field: 'bcc[1]' }));
  });
});

describe('header encoding primitives', () => {
  it('checkHeaderName() refuses names over 76 characters', () => {
    expect(checkHeaderName(`X-${'a'.repeat(74)}`, 'h')).toHaveLength(76);
    expect(() => checkHeaderName(`X-${'a'.repeat(75)}`, 'h')).toThrow(MailMessageError);
  });

  it('encodePhrase(): atoms as they are, specials quoted and escaped, non-ASCII encoded', () => {
    expect(encodePhrase('Ada Lovelace')).toEqual(['Ada', ' Lovelace']);
    expect(encodePhrase('Ada "A" L. \\ x')).toEqual(['"Ada \\"A\\" L. \\\\ x"']);
    expect(encodePhrase('Zoë')).toEqual(['=?UTF-8?Q?Zo=C3=AB?=']);
    expect(encodePhrase('looks =?like?= a word')[0]).toMatch(/^=\?UTF-8\?[BQ]\?/);
  });

  it('encodeText() keeps ASCII words with their whitespace, and encodes a word over 900 characters', () => {
    expect(encodeText('Your  order\tshipped')).toEqual(['Your', '  order', '\tshipped']);
    expect(encodeText(`a ${'b'.repeat(901)}`)[0]).toMatch(/^=\?UTF-8\?/);
  });

  it('encodeWords() picks B when it is shorter than Q, and never splits a character', () => {
    const cjk = '山田太郎'.repeat(10);
    const words = encodeWords(cjk);
    expect(words.every((w) => w.trim().startsWith('=?UTF-8?B?') && w.trim().length <= 75)).toBe(true);
    expect(decodeWords(words.join(''))).toBe(cjk);

    for (const word of words) {
      const payload = word.trim().slice(10, -2);
      expect(Buffer.from(payload, 'base64').toString('utf8')).not.toContain('�');
    }
  });

  it('encodeWords() leaves room on the first line for the header name', () => {
    const [first] = encodeWords('ż'.repeat(40), 'X-Very-Long-Header-Name-Here'.length + 2);
    expect(`X-Very-Long-Header-Name-Here: ${first}`.length).toBeLessThanOrEqual(78);
  });

  it('foldHeader() folds only at whitespace, and refuses a piece that cannot fit 998 characters', () => {
    const folded = foldHeader('X-List', Array.from({ length: 30 }, (_, i) => `${i ? ' ' : ''}item${i}`));
    expect(folded.split('\r\n').every((line) => line.length <= 78)).toBe(true);
    expect(folded.replace(/\r\n/g, '')).toBe(`X-List: ${Array.from({ length: 30 }, (_, i) => `item${i}`).join(' ')}`);

    expect(() => foldHeader('X-Long', ['a'.repeat(1_000)])).toThrow('Invalid mail: headers.X-Long has a word longer than 996 characters');
  });

  it('formatDate() writes RFC 5322 dates in UTC', () => {
    expect(formatDate(new Date(Date.UTC(2026, 0, 4, 3, 5, 9)))).toBe('Sun, 04 Jan 2026 03:05:09 +0000');
  });

  it('mimeParameter(): quoted when short ASCII, RFC 2231 otherwise, with continuations when long', () => {
    expect(mimeParameter('filename', 'a "b".pdf')).toEqual(['filename="a \\"b\\".pdf"']);
    expect(mimeParameter('filename', 'zażółć.pdf')).toEqual(["filename*=UTF-8''za%C5%BC%C3%B3%C5%82%C4%87.pdf"]);

    const long = mimeParameter('filename', `${'x'.repeat(100)}.pdf`);
    expect(long.length).toBeGreaterThan(1);
    expect(long.map((p) => p.slice(0, p.indexOf('='))).slice(0, 2)).toEqual(['filename*0*', 'filename*1*']);
    expect(parseContentType(`attachment; ${long.join('; ')}`)[1].filename).toBe(`${'x'.repeat(100)}.pdf`);
  });
});

describe('body encoding choice', () => {
  it('normalizes every kind of line break to CRLF', () => {
    expect(normalizeNewlines('a\nb\rc\r\nd')).toBe('a\r\nb\r\nc\r\nd');
  });

  it.each([
    ['short ASCII lines', 'Hello\nWorld', '7bit'],
    ['a line over 76 characters', 'x'.repeat(77), 'quoted-printable'],
    ['a line that starts with a dot', 'a\n.b', 'quoted-printable'],
    ['trailing whitespace', 'a \nb', 'quoted-printable'],
    ['"=_", which could be taken for a boundary', 'a=_b', 'quoted-printable'],
    ['non-ASCII', 'Zoë', 'quoted-printable'],
    ['a control character', 'a\u0007b', 'quoted-printable'],
  ])('uses the right encoding for %s', (_case, text, encoding) => {
    expect(encodeTextBody(text).encoding).toBe(encoding);
  });
});

describe('building a message', () => {
  it('uses the given time as the Date header', async () => {
    const message = await build({}, { from: FROM }, new Date(Date.UTC(2026, 8, 22, 18, 4, 5)));
    expect(message.date.toISOString()).toBe('2026-09-22T18:04:05.000Z');
    expect(message.toMime().toString()).toContain('Date: Tue, 22 Sep 2026 18:04:05 +0000');
  });

  it('merges the module headers under the message headers, and skips undefined values', async () => {
    const message = await build(
      { headers: { 'X-Campaign': 'autumn', 'X-Skip': undefined as never } },
      { from: FROM, headers: { 'X-Campaign': 'default', 'X-App': 'shop' } },
    );
    expect(message.headers).toEqual({ 'X-App': 'shop', 'X-Campaign': 'autumn' });
  });

  it("uses the module's replyTo unless the message sets its own", async () => {
    const defaults = { from: FROM, replyTo: ['help@example.com', 'Billing <billing@example.com>'] };
    expect((await build({}, defaults)).replyTo).toEqual([{ address: 'help@example.com' }, { name: 'Billing', address: 'billing@example.com' }]);
    expect((await build({ replyTo: 'me@example.com' }, defaults)).replyTo).toEqual([{ address: 'me@example.com' }]);
  });

  it('a message from overrides the default, and sets the Message-ID domain', async () => {
    const message = await build({ from: 'news@news.example.com' });
    expect(message.from).toEqual({ address: 'news@news.example.com' });
    expect(message.messageId).toMatch(/@news\.example\.com>$/);
  });

  it('flags SMTPUTF8 for a non-ASCII local part in from or replyTo too', async () => {
    expect((await build({ from: 'zoë@example.com' })).internationalized).toBe(true);
    expect((await build({ replyTo: 'zoë@example.com' })).internationalized).toBe(true);
    // An IDN domain is converted to ASCII: no SMTPUTF8 needed
    expect((await build({ to: 'a@bücher.example' })).internationalized).toBe(false);
  });

  it.each([
    [{ subject: 42 }, 'subject must be a string'],
    [{ html: 42 }, 'html must be a string or the result of the html template'],
    [{ text: ['a'] }, 'text must be a string'],
    [{ idempotencyKey: '' }, 'idempotencyKey must be a non-empty string'],
    [{ attachments: [null] }, 'attachments[0] must be an object'],
    [{ attachments: [{ filename: 'a.txt', content: 42 }] }, 'attachments[0].content must be a string, a Buffer, or a readable stream'],
    [{ attachments: [{ filename: '   ', content: 'x' }] }, 'attachments[0].filename must be a non-empty string'],
    [{ attachments: [{ filename: `${'a'.repeat(252)}.pdf`, content: 'x' }] }, 'attachments[0].filename is longer than 255 characters'],
    [{ attachments: [{ filename: 'a', content: 'x', path: '/tmp/a' }] }, 'attachments[0] needs exactly one of `content` and `path`'],
  ])('refuses %j', async (input, message) => {
    await expect(build(input as never)).rejects.toThrow(`Invalid mail: ${message}`);
  });

  it('refuses every header the message sets itself', async () => {
    for (const name of ['From', 'To', 'Cc', 'Reply-To', 'Subject', 'Date', 'Sender', 'Return-Path', 'MIME-Version', 'Content-Transfer-Encoding', 'Content-Disposition', 'Content-ID', 'DKIM-Signature']) {
      await expect(build({ headers: { [name]: 'x' } })).rejects.toThrow(`Invalid mail: headers.${name} can't be set as a header`);
    }
  });

  it('infers content types from the extension, case-insensitively, and lowercases a given one', async () => {
    const message = await build({
      attachments: [
        { filename: 'Photo.JPG', content: 'x' },
        { filename: 'invite.ics', content: 'x' },
        { filename: 'report.xlsx', content: 'x' },
        { filename: 'noext', content: 'x' },
        { filename: 'data.bin', content: 'x', contentType: ' Application/X-Custom ' },
      ],
    });
    expect(message.attachments.map((a) => a.contentType)).toEqual([
      'image/jpeg',
      'text/calendar',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream',
      'application/x-custom',
    ]);
  });

  it('takes a Uint8Array as content, and a path with a filename override', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-att-'));
    try {
      writeFileSync(join(dir, 'raw.dat'), 'from disk');
      const message = await build({
        attachments: [
          { filename: 'bytes.bin', content: new Uint8Array([1, 2, 3]) },
          { path: join(dir, 'raw.dat'), filename: 'Report.pdf' },
        ],
      });
      expect(message.attachments.map((a) => [a.filename, a.contentType, [...a.content]])).toEqual([
        ['bytes.bin', 'application/octet-stream', [1, 2, 3]],
        ['Report.pdf', 'application/pdf', [...Buffer.from('from disk')]],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when an attachment file does not exist', async () => {
    await expect(build({ attachments: [{ path: join(tmpdir(), 'mail-missing-file.pdf') }] })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('assertRecipients() is satisfied by cc or bcc alone', async () => {
    const noOne = await build({ to: undefined });
    expect(() => assertRecipients(noOne)).toThrow('Invalid mail: to is missing: a mail needs at least one recipient (to, cc or bcc)');
    expect(() => assertRecipients(noOne)).toThrow(MailMessageError);
    assertRecipients(await build({ to: undefined, cc: 'c@example.com' }));
    assertRecipients(await build({ to: undefined, bcc: 'b@example.com' }));
  });

  it('gives a fresh random Message-ID without an idempotency key', async () => {
    const [a, b] = await Promise.all([build({}), build({})]);
    expect(a.messageId).not.toBe(b.messageId);
  });

  it('is immutable, and toMime() returns a copy of the same bytes', async () => {
    const message = await build({ attachments: [{ filename: 'a.txt', content: 'x' }] });

    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.to[0])).toBe(true);
    expect(Object.isFrozen(message.attachments[0])).toBe(true);
    expect(() => {
      (message as { subject: string }).subject = 'changed';
    }).toThrow(TypeError);

    const first = message.toMime();
    first.fill(0);
    expect(message.toMime().toString()).toContain('Subject: Hello');
    expect(message.toMime().equals(message.toMime())).toBe(true);
  });
});

describe('MIME structure without the full tree', () => {
  it('sends an html-only mail as alternative, with the text derived from the html', async () => {
    const message = await build({ text: undefined, html: html`<p>Hi ${'<b>'}</p>` });
    expect(message.text).toBe('Hi <b>');
    expect(message.html).toBe('<p>Hi &lt;b&gt;</p>');
  });

  it('keeps an explicit empty text as it is, instead of deriving one', async () => {
    const message = await build({ text: '', html: '<p>Hi</p>' });
    expect(message.text).toBe('');
  });

  it('attaches an inline part as an ordinary attachment when there is no html to show it', async () => {
    const tree = await parsed({ text: 'Plain only', attachments: [{ cid: 'logo', filename: 'logo.png', content: 'png' }] });

    expect(tree.type).toBe('multipart/mixed');
    expect(tree.parts.map((p) => p.type)).toEqual(['text/plain', 'image/png']);
    expect(header(tree.parts[1].headers, 'content-id')).toBe('<logo>');
  });

  it('puts text and attachments in mixed, with no alternative', async () => {
    const tree = await parsed({ attachments: [{ filename: 'a.txt', content: 'A' }, { filename: 'b.txt', content: 'B' }] });

    expect(tree.type).toBe('multipart/mixed');
    expect(leaves(tree).map((p) => [p.type, p.body.toString()])).toEqual([
      ['text/plain', 'Hi'],
      ['text/plain', 'A'],
      ['text/plain', 'B'],
    ]);
  });

  it('writes Reply-To and Cc, and folds a long To between addresses', async () => {
    const to = Array.from({ length: 8 }, (_, i) => ({ name: `Recipient Number ${i}`, address: `recipient${i}@example.com` }));
    const raw = (await build({ to, cc: 'cc@example.com', replyTo: 'help@example.com' })).toMime().toString();
    const head = raw.slice(0, raw.indexOf('\r\n\r\n'));

    expect(head).toContain('\r\nReply-To: help@example.com\r\n');
    expect(head).toContain('\r\nCc: cc@example.com\r\n');
    expect(head.split('\r\n').every((line) => line.length <= 78)).toBe(true);
    expect(header(parseMessage(raw).headers, 'to')!.split(', ')).toHaveLength(8);
  });

  it('writes a multipart boundary no part of the body contains', async () => {
    const tree = await parsed({ text: '--=_ not a boundary\n--', html: '<p>--=_</p>' });
    expect(tree.parts.map((p) => p.body.toString())).toEqual(['--=_ not a boundary\r\n--', '<p>--=_</p>']);
  });
});
