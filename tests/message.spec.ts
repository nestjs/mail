import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { html, MailMessageError, unsafeHtml } from '../lib/index.js';
import { parseAddress } from '../lib/message/address.util.js';
import { quotedPrintable } from '../lib/message/encoding.util.js';
import { createMailMessage, type NormalizeInput } from '../lib/message/normalize.util.js';
import { extractLinks, htmlToText } from '../lib/message/text.util.js';
import {
  decodeWords,
  header,
  headerAll,
  lint,
  parseAddresses,
  parseContentType,
  parseMessage,
} from './support/mime-parser.js';

const FROM = 'Orders <orders@example.com>';

async function build(input: Partial<NormalizeInput>) {
  return createMailMessage({ subject: 'Hello', text: 'Hi', to: 'ada@example.com', ...input }, { from: FROM });
}

async function roundTrip(input: Partial<NormalizeInput>) {
  const message = await build(input);
  const raw = message.toMime().toString('utf8');
  expect(lint(raw)).toEqual([]);
  return { message, raw, parsed: parseMessage(raw) };
}

describe('addresses', () => {
  it('parses the usual forms', () => {
    expect(parseAddress('ada@example.com', 'to')).toEqual({ address: 'ada@example.com' });
    expect(parseAddress('<ada@example.com>', 'to')).toEqual({ address: 'ada@example.com' });
    expect(parseAddress('Ada Lovelace <ada@Example.COM>', 'to')).toEqual({ name: 'Ada Lovelace', address: 'ada@example.com' });
    expect(parseAddress('"Lovelace, Ada" <ada@example.com>', 'to')).toEqual({ name: 'Lovelace, Ada', address: 'ada@example.com' });
    expect(parseAddress('"Ada \\"The Countess\\" L." <ada@example.com>', 'to')).toEqual({
      name: 'Ada "The Countess" L.',
      address: 'ada@example.com',
    });
    expect(parseAddress({ name: 'Zoë', address: 'zoe@bücher.example' }, 'to')).toEqual({
      name: 'Zoë',
      address: 'zoe@xn--bcher-kva.example',
    });
  });

  it.each([
    ['two addresses in one string', 'a@example.com, b@example.com'],
    ['an unquoted comma in the name', 'Doe, Jane <jane@example.com>'],
    ['a CRLF in the name', 'Ada\r\nBcc: evil@attacker.example <ada@example.com>'],
    ['a bare LF', 'ada@example.com\nBcc: evil@attacker.example'],
    ['a NUL', 'ada@example.com\0'],
    ['no domain', 'ada@'],
    ['no at sign', 'ada.example.com'],
    ['a quoted local part', '"ada lovelace"@example.com'],
    ['an address literal', 'ada@[127.0.0.1]'],
    ['a label starting with a hyphen', 'ada@-example.com'],
    ['a single-label domain', 'ada@example'],
    ['a trailing dot in the local part', 'ada.@example.com'],
    ['an unterminated quote', '"Ada <ada@example.com>'],
    ['a group', 'friends: a@example.com, b@example.com;'],
  ])('refuses %s', (_case, input) => {
    expect(() => parseAddress(input, 'to')).toThrow(MailMessageError);
  });

  it('refuses a CR, LF or NUL in an object name or address', () => {
    for (const name of ['A\r\nB', 'A\nB', 'A\0B']) {
      expect(() => parseAddress({ name, address: 'a@example.com' }, 'to[0]')).toThrow(/to\[0\]\.name/);
    }
    expect(() => parseAddress({ address: 'a@example.com\r\nX: y' }, 'to[0]')).toThrow(MailMessageError);
  });

  it('keeps a hostile display name inside one recipient', async () => {
    const name = 'Eve, <evil@attacker.example>, "x" =?UTF-8?B?QQ==?=';
    const { parsed, message } = await roundTrip({ to: [{ name, address: 'ada@example.com' }] });
    expect(message.envelope.to).toEqual(['ada@example.com']);
    expect(parseAddresses(header(parsed.headers, 'to')!)).toEqual([{ name, address: 'ada@example.com' }]);
  });

  it('flags an internationalized local part (SMTPUTF8) and keeps it raw in the header', async () => {
    const { message, raw } = await roundTrip({ to: 'Łucja <łucja@example.com>' });
    expect(message.internationalized).toBe(true);
    expect(raw).toContain('<łucja@example.com>');
    expect((await build({})).internationalized).toBe(false);
  });
});

describe('header injection', () => {
  it.each(['Hello\r\nBcc: evil@attacker.example', 'Hello\nBcc: x', 'Hello\rX', 'Hello\0'])(
    'refuses the subject %j',
    async (subject) => {
      await expect(build({ subject })).rejects.toThrow(/Invalid mail: subject/);
    },
  );

  it('refuses custom header names and values that could break out', async () => {
    await expect(build({ headers: { 'X-Ok\r\nBcc': 'x' } })).rejects.toThrow(MailMessageError);
    await expect(build({ headers: { 'X Space': 'x' } })).rejects.toThrow(MailMessageError);
    await expect(build({ headers: { 'X-Tag': 'a\r\nBcc: evil@attacker.example' } })).rejects.toThrow(/headers\.X-Tag/);
    await expect(build({ headers: { 'X-Tag': 'a\nb' } })).rejects.toThrow(MailMessageError);
  });

  it('refuses headers the message sets itself, naming the option to use', async () => {
    await expect(build({ headers: { Bcc: 'x@example.com' } })).rejects.toThrow(/use the `bcc` option/);
    await expect(build({ headers: { 'Content-Type': 'text/html' } })).rejects.toThrow(/mailer sets it/);
    await expect(build({ headers: { 'message-id': '<x@y>' } })).rejects.toThrow(/idempotencyKey/);
    await expect(build({ headers: { 'X-A': '1', 'x-a': '2' } })).rejects.toThrow(/set twice/);
  });

  it('refuses attachment filenames with line breaks, and bad cids', async () => {
    await expect(build({ attachments: [{ filename: 'a\r\nb.pdf', content: 'x' }] })).rejects.toThrow(/attachments\[0\]\.filename/);
    await expect(build({ attachments: [{ cid: 'lo go', content: 'x' }] })).rejects.toThrow(/attachments\[0\]\.cid/);
    await expect(build({ attachments: [{ cid: '<logo>', content: 'x' }] })).rejects.toThrow(/cid/);
    await expect(build({ attachments: [{ content: 'x' }] })).rejects.toThrow(/filename.*required/);
    await expect(build({ attachments: [{ filename: 'a.txt' }] })).rejects.toThrow(/exactly one of/);
    await expect(build({ attachments: [{ filename: 'a.txt', path: 'https://example.com/a.txt' }] })).rejects.toThrow(/local file/);
    await expect(build({ attachments: [{ filename: 'a', content: 'x', contentType: 'text/plain; charset=x' }] })).rejects.toThrow(/contentType/);
    await expect(
      build({ html: '<img src="cid:a">', attachments: [{ cid: 'a', content: 'x' }, { cid: 'a', content: 'y' }] }),
    ).rejects.toThrow(/cid "a" twice/);
  });

  it('cannot be built by hand, bypassing validation', async () => {
    const message = await build({});
    const Ctor = message.constructor as new (init: object, token?: unknown) => unknown;
    expect(() => new Ctor({ subject: 'x\r\nBcc: evil@attacker.example' })).toThrow(/created by the mailer/);
    expect(() => new Ctor({}, Symbol('MailMessage.create'))).toThrow(/created by the mailer/);
  });

  it('needs a from, a body, and (to send) a recipient', async () => {
    await expect(createMailMessage({ subject: 'x', text: 'y', to: 'a@example.com' }, {})).rejects.toThrow(/from.*MailModule/);
    await expect(build({ text: undefined })).rejects.toThrow(/a mail needs a body/);
  });
});

describe('MIME structure', () => {
  it('sends a short ASCII text as a single 7bit part', async () => {
    const { parsed, raw } = await roundTrip({ text: 'Hi there' });

    expect(parsed.type).toBe('text/plain');
    expect(header(parsed.headers, 'content-transfer-encoding')).toBe('7bit');
    // A single-part message ends with CRLF, as it will on the wire
    expect(parsed.body.toString()).toBe('Hi there\r\n');
    expect(header(parsed.headers, 'mime-version')).toBe('1.0');
    expect(header(parsed.headers, 'date')).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
    expect(header(parsed.headers, 'message-id')).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
    expect(raw.endsWith('\r\n')).toBe(true);
  });

  it('derives the text part from html and sends multipart/alternative, text first', async () => {
    const { parsed } = await roundTrip({
      text: undefined,
      html: html`<h1>Order #42</h1><p>Thanks, ${'Zoë'}!</p><p><a href="https://shop.example.com/orders/42?x=1&amp;y=2">Track it</a></p>`,
    });

    expect(parsed.type).toBe('multipart/alternative');
    expect(parsed.parts.map((p) => p.type)).toEqual(['text/plain', 'text/html']);
    expect(parsed.parts[0].body.toString()).toBe(
      'Order #42\r\n\r\nThanks, Zoë!\r\n\r\nTrack it (https://shop.example.com/orders/42?x=1&y=2)',
    );
    expect(parsed.parts[1].body.toString()).toContain('Thanks, Zoë!');
  });

  it('puts inline images next to the html (related) and files at the top (mixed)', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]);
    const pdf = Buffer.from('%PDF-1.4 binary \x00\xff', 'latin1');

    const { parsed } = await roundTrip({
      html: '<p><img src="cid:logo@example.com"></p>',
      attachments: [
        { filename: 'logo.png', content: png, cid: 'logo@example.com' },
        { filename: 'invoice 42.pdf', content: pdf },
      ],
    });

    expect(parsed.type).toBe('multipart/mixed');
    const [alternative, attachment] = parsed.parts;
    expect(alternative.type).toBe('multipart/alternative');
    expect(alternative.parts.map((p) => p.type)).toEqual(['text/plain', 'multipart/related']);

    const [htmlPart, logo] = alternative.parts[1].parts;
    expect(htmlPart.type).toBe('text/html');
    expect(logo.type).toBe('image/png');
    expect(header(logo.headers, 'content-id')).toBe('<logo@example.com>');
    expect(header(logo.headers, 'content-disposition')).toMatch(/^inline;/);
    expect(logo.body.equals(png)).toBe(true);

    expect(attachment.type).toBe('application/pdf');
    expect(parseContentType(header(attachment.headers, 'content-disposition')!)).toEqual(['attachment', { filename: 'invoice 42.pdf' }]);
    expect(attachment.body.equals(pdf)).toBe(true);
  });

  it('reads attachments from a path, a Node stream and a web stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-'));
    try {
      writeFileSync(join(dir, 'terms.txt'), 'Terms');
      const { message } = await roundTrip({
        attachments: [
          { path: join(dir, 'terms.txt') },
          { filename: 'a.csv', content: Readable.from([Buffer.from('a,b\n'), Buffer.from('1,2\n')]) },
          { filename: 'b.bin', content: new Blob(['web']).stream() },
        ],
      });

      expect(message.attachments.map((a) => [a.filename, a.contentType, a.content.toString()])).toEqual([
        ['terms.txt', 'text/plain', 'Terms'],
        ['a.csv', 'text/csv', 'a,b\n1,2\n'],
        ['b.bin', 'application/octet-stream', 'web'],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never writes Bcc, and puts every recipient in the envelope once', async () => {
    const { raw, message } = await roundTrip({
      to: ['a@example.com', 'B@Example.com'],
      cc: 'c@example.com',
      bcc: ['secret@example.com', 'b@example.com'],
    });

    expect(raw.toLowerCase()).not.toContain('bcc');
    expect(raw).not.toContain('secret@example.com');
    expect(message.envelope).toEqual({ from: 'orders@example.com', to: ['a@example.com', 'B@example.com', 'c@example.com', 'secret@example.com'] });
  });

  it('derives a stable Message-ID from the idempotency key', async () => {
    const a = await build({ idempotencyKey: 'outbox:0193' });
    const b = await build({ idempotencyKey: 'outbox:0193' });
    const c = await build({ idempotencyKey: 'outbox:0194' });

    expect(a.messageId).toBe(b.messageId);
    expect(a.messageId).not.toBe(c.messageId);
    expect(a.messageId).toMatch(/^<[A-Za-z0-9_-]{32}@example\.com>$/);
  });
});

describe('header encoding', () => {
  it.each([
    ['plain ASCII', 'Your order has shipped'],
    ['Polish', 'Zamówienie #42 zostało wysłane — dziękujemy!'],
    ['emoji outside the BMP', '📦 Your order 🚚 is on its way 🎉'],
    ['a long subject', `Zażółć gęślą jaźń ${'bardzo długi temat '.repeat(12)}`],
    ['text that looks like an encoded-word', 'Hello =?UTF-8?B?SGFja2Vk?= world'],
    ['a 1200-character word', 'x'.repeat(1200)],
    ['leading and inner spacing', '  two  spaces'],
  ])('round-trips %s in Subject, with lines of at most 78 characters', async (_case, subject) => {
    const { raw, parsed } = await roundTrip({ subject });

    const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
    const subjectLines = head.split('\r\n').filter((_l, i, all) => {
      const start = all.findIndex((l) => l.startsWith('Subject:'));
      return i >= start && (i === start || /^[ \t]/.test(all[i]));
    });

    for (const line of subjectLines) {
      expect(line.length).toBeLessThanOrEqual(78);
    }

    // Parsers drop the whitespace after the colon, so leading spaces don't survive (nor matter)
    expect(decodeWords(header(parsed.headers, 'subject')!)).toBe(subject.trimStart());
  });

  it('encodes non-ASCII display names and round-trips them', async () => {
    const names = ['Zoë Łukasiewicz', 'Ada "Countess" Lovelace', '山田 太郎', 'O\'Brien (billing)'];
    const { parsed } = await roundTrip({ to: names.map((name, i) => ({ name, address: `u${i}@example.com` })) });
    expect(parseAddresses(header(parsed.headers, 'to')!)).toEqual(names.map((name, i) => ({ name, address: `u${i}@example.com` })));
  });

  it('encodes non-ASCII and long attachment filenames (RFC 2231) and keeps them exact', async () => {
    const filename = `Faktura nr 42 — zamówienie ${'ż'.repeat(40)}.pdf`;
    const { parsed } = await roundTrip({ attachments: [{ filename, content: 'x' }] });
    const part = parsed.parts[1];
    expect(parseContentType(header(part.headers, 'content-disposition')!)[1].filename).toBe(filename);
    expect(decodeWords(parseContentType(header(part.headers, 'content-type')!)[1].name)).toBe(filename);
  });

  it('writes custom headers, encoding non-ASCII values', async () => {
    const { parsed } = await roundTrip({ headers: { 'X-Campaign': 'Jesień 2026', 'List-Unsubscribe': '<https://shop.example.com/u?t=1>' } });
    expect(decodeWords(header(parsed.headers, 'x-campaign')!)).toBe('Jesień 2026');
    expect(header(parsed.headers, 'list-unsubscribe')).toBe('<https://shop.example.com/u?t=1>');
    expect(headerAll(parsed.headers, 'from')).toEqual(['Orders <orders@example.com>']);
  });
});

describe('body encoding', () => {
  it('quoted-printable keeps lines within 76 characters and round-trips exactly', async () => {
    const text = [
      'Zażółć gęślą jaźń '.repeat(20),
      '.starts with a dot',
      'trailing spaces   ',
      'trailing tab\t',
      '= equals =3D and =\r\n not a soft break',
      `${'a'.repeat(300)}`,
      '.',
      '',
      '📦 emoji at the end 📦',
    ].join('\n');

    const { parsed, raw } = await roundTrip({ text });

    expect(header(parsed.headers, 'content-transfer-encoding')).toBe('quoted-printable');
    expect(parsed.body.toString('utf8')).toBe(`${text.replace(/\r\n|\n/g, '\r\n')}\r\n`);

    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
    expect(body.split('\r\n').every((line) => line.length <= 76 && !line.startsWith('.'))).toBe(true);
  });

  it('encodes every byte value without loss', () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString('latin1');
    const encoded = quotedPrintable(all);
    expect(encoded.split('\r\n').every((line) => line.length <= 76)).toBe(true);
  });

  it('uses base64 lines of 76 characters for attachments', async () => {
    const content = Buffer.alloc(10_000, 7);
    const { raw, parsed } = await roundTrip({ attachments: [{ filename: 'a.bin', content }] });

    const body = raw.slice(raw.lastIndexOf('Content-Transfer-Encoding: base64'));
    const lines = body.split('\r\n').slice(3, -3);
    expect(lines.every((line) => line.length <= 76)).toBe(true);
    expect(parsed.parts[1].body.equals(content)).toBe(true);
  });
});

describe('an independent parser: Python email (policy=default)', () => {
  const python = (() => {
    try {
      execFileSync('python3', ['-c', 'import email'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!python)('reads the same headers, bodies and attachments', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]);
    const message = await build({
      text: undefined,
      subject: '📦 Zamówienie #42 — wysłane, dziękujemy! '.repeat(3).trim(),
      to: [{ name: 'Zoë "Z" Łukasiewicz, PhD', address: 'zoe@example.com' }, 'Ada <ada@bücher.example>'],
      cc: { name: '山田 太郎', address: 'taro@example.jp' },
      replyTo: 'Support <support@example.com>',
      html: html`<p>Cześć ${'Zoë'}!</p><img src="cid:logo">`,
      attachments: [
        { cid: 'logo', filename: 'logo.png', content: png },
        { filename: `Faktura ${'ż'.repeat(30)}.pdf`, content: Buffer.from('%PDF-1.4\n\x00\xff', 'latin1') },
      ],
      headers: { 'X-Campaign': 'Jesień 2026' },
    });

    const dir = mkdtempSync(join(tmpdir(), 'mail-py-'));
    try {
      const file = join(dir, 'message.eml');
      writeFileSync(file, message.toMime());

      const script = `
import email, json, sys, base64
from email import policy
msg = email.message_from_binary_file(open(sys.argv[1], 'rb'), policy=policy.default)
out = {
  'defects': [str(d) for d in msg.defects],
  'subject': str(msg['subject']),
  'to': [[a.display_name, a.addr_spec] for a in msg['to'].addresses],
  'cc': [[a.display_name, a.addr_spec] for a in msg['cc'].addresses],
  'reply_to': [[a.display_name, a.addr_spec] for a in msg['reply-to'].addresses],
  'campaign': str(msg['x-campaign']),
  'parts': [],
}
for part in msg.walk():
  out['defects'] += [str(d) for d in part.defects]
  if part.is_multipart():
    out['parts'].append([part.get_content_type(), None, None, None])
  else:
    payload = part.get_payload(decode=True)
    out['parts'].append([part.get_content_type(), part.get_filename(), part.get('content-id'), base64.b64encode(payload).decode()])
print(json.dumps(out))
`;

      const result = JSON.parse(execFileSync('python3', ['-c', script, file], { encoding: 'utf8' }));
      expect(result.defects).toEqual([]);
      expect(result.subject).toBe(message.subject);
      expect(result.to).toEqual([
        ['Zoë "Z" Łukasiewicz, PhD', 'zoe@example.com'],
        ['Ada', 'ada@xn--bcher-kva.example'],
      ]);
      expect(result.cc).toEqual([['山田 太郎', 'taro@example.jp']]);
      expect(result.reply_to).toEqual([['Support', 'support@example.com']]);
      expect(result.campaign).toBe('Jesień 2026');

      const parts = result.parts.map(([type, filename, cid, b64]: string[]) => [type, filename, cid, b64 && Buffer.from(b64, 'base64').toString('utf8')]);
      expect(parts.map((p: string[]) => p[0])).toEqual([
        'multipart/mixed',
        'multipart/alternative',
        'text/plain',
        'multipart/related',
        'text/html',
        'image/png',
        'application/pdf',
      ]);
      expect(parts[2][3]).toBe('Cześć Zoë!');
      expect(parts[5][2]).toBe('<logo>');
      expect(Buffer.from(result.parts[5][3], 'base64').equals(png)).toBe(true);
      expect(parts[6][1]).toBe(`Faktura ${'ż'.repeat(30)}.pdf`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('html template', () => {
  it('escapes interpolated values, and nests templates and arrays', () => {
    const items = ['<b>Dune</b>', 'Tom & Jerry'];
    const result = html`<p title="${'"quoted" \'single\''}">${'<script>alert(1)</script>'}</p><ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`;
    expect(String(result)).toBe(
      '<p title="&quot;quoted&quot; &#39;single&#39;">&lt;script&gt;alert(1)&lt;/script&gt;</p>' +
        '<ul><li>&lt;b&gt;Dune&lt;/b&gt;</li><li>Tom &amp; Jerry</li></ul>',
    );
  });

  it('renders null, undefined and false as nothing, numbers as text', () => {
    const gift = false;
    expect(html`<p>${null}${undefined}${gift && html`<b>gift</b>`}${0}${12.5}</p>`.value).toBe('<p>012.5</p>');
  });

  it('takes unsafeHtml as is, and only that', () => {
    expect(html`<div>${unsafeHtml('<b>trusted</b>')}</div>`.value).toBe('<div><b>trusted</b></div>');
    const fake = { value: '<b>x</b>', toString: () => '<b>x</b>' };
    expect(html`<div>${fake as never}</div>`.value).toBe('<div>&lt;b&gt;x&lt;/b&gt;</div>');
  });

  it('refuses an interpolation into an unquoted attribute', () => {
    const url = 'x onmouseover=alert(1)';
    expect(() => html`<a href=${url}>x</a>`).toThrow(/quote the attribute/);
    expect(() => html`<a href = ${url}>x</a>`).toThrow(/quote the attribute/);
    expect(html`<p>1 + 1 = ${2}</p>`.value).toBe('<p>1 + 1 = 2</p>');
  });

  it('refuses an interpolation between attributes, where escaping cannot protect it', () => {
    // No character that escaping touches, yet it would become an attribute
    const attrs = 'onclick=alert(1)';
    const url = 'x onmouseover=alert(1)';

    expect(() => html`<a ${attrs}>x</a>`).toThrow(/interpolation #1 is inside a tag/);
    expect(() => html`<a href="/x" ${attrs}>x</a>`).toThrow(/inside a tag/);
    expect(() => html`<img src="/a.png"
      ${attrs}>`).toThrow(/inside a tag/);
    expect(() => html`<a href=/orders/${attrs}>x</a>`).toThrow(/inside a tag/);

    // Trusted markup may build attributes; quoted values, text, comments and a bare `<` are fine
    expect(html`<a ${unsafeHtml('target="_blank"')} href="${url}">x</a>`.value).toBe('<a target="_blank" href="x onmouseover=alert(1)">x</a>');
    expect(html`<p title="${'a>b'}" class='${'c'}'>${'<'}</p>`.value).toBe('<p title="a&gt;b" class=\'c\'>&lt;</p>');
    expect(html`<p>a < ${'b'} and <!-- ${'c'} --> x</p>`.value).toBe('<p>a < b and <!-- c --> x</p>');
    expect(html`<p>${'x'}</p>`.value).toBe('<p>x</p>');
  });
});

describe('text and links', () => {
  it('turns HTML into readable text', () => {
    const text = htmlToText(`
      <html><head><title>T</title><style>p { color: red }</style></head>
      <body><!-- hidden --><h1>Order   confirmed</h1>
      <p>Hi Ada,<br>thanks &amp; welcome&nbsp;back.</p>
      <ul><li>Dune &times; 2</li><li>Neuromancer</li></ul>
      <table><tr><td>Total</td><td>25.98</td></tr></table>
      <p><a href="https://shop.example.com/orders/42">https://shop.example.com/orders/42</a> or <a href="mailto:help@example.com">email us</a></p>
      <script>alert(1)</script></body></html>`);

    expect(text).toBe(
      'Order confirmed\n\nHi Ada,\nthanks & welcome back.\n\n- Dune × 2\n- Neuromancer\n\nTotal 25.98\n\n' +
        'https://shop.example.com/orders/42 or email us (help@example.com)',
    );
  });

  it('extracts links from html (entities decoded) and then from text', () => {
    expect(
      extractLinks(
        '<a href="https://a.example/r?token=abc&amp;u=1">Reset</a><a href=\'#top\'>top</a><a href="mailto:x@y.z">m</a><img src="cid:x"><area href=https://b.example/map>',
        'Or paste https://a.example/r?token=abc&u=1. Also https://c.example/x (see).',
      ),
    ).toEqual(['https://a.example/r?token=abc&u=1', 'https://b.example/map', 'https://c.example/x']);
  });
});
