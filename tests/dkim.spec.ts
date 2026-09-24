import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import {
  computeSignature,
  createDkimSigner,
  parseHeaderFields,
  relaxedBody,
  relaxedHeader,
} from '../lib/smtp/dkim.util.js';
import { createMailMessage } from '../lib/message/normalize.util.js';

/** RFC 8463 Appendix A: keys, and a message signed with both algorithms (CRLF line endings). */
const ED25519_SEED = 'nWGxne/9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A=';
const ED25519_PUBLIC = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';
const RSA_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQDkHlOQoBTzWRiGs5V6NpP3idY6Wk08a5qhdR6wy5bdOKb2jLQi
Y/J16JYi0Qvx/byYzCNb3W91y3FutACDfzwQ/BC/e/8uBsCR+yz1Lxj+PL6lHvqM
KrM3rG4hstT5QjvHO9PzoxZyVYLzBfO2EeC3Ip3G+2kryOTIKT+l/K4w3QIDAQAB
AoGAH0cxOhFZDgzXWhDhnAJDw5s4roOXN4OhjiXa8W7Y3rhX3FJqmJSPuC8N9vQm
6SVbaLAE4SG5mLMueHlh4KXffEpuLEiNp9Ss3O4YfLiQpbRqE7Tm5SxKjvvQoZZe
zHorimOaChRL2it47iuWxzxSiRMv4c+j70GiWdxXnxe4UoECQQDzJB/0U58W7RZy
6enGVj2kWF732CoWFZWzi1FicudrBFoy63QwcowpoCazKtvZGMNlPWnC7x/6o8Gc
uSe0ga2xAkEA8C7PipPm1/1fTRQvj1o/dDmZp243044ZNyxjg+/OPN0oWCbXIGxy
WvmZbXriOWoSALJTjExEgraHEgnXssuk7QJBALl5ICsYMu6hMxO73gnfNayNgPxd
WFV6Z7ULnKyV7HSVYF0hgYOHjeYe9gaMtiJYoo0zGN+L3AAtNP9huqkWlzECQE1a
licIeVlo1e+qJ6Mgqr0Q7Aa7falZ448ccbSFYEPD6oFxiOl9Y9se9iYHZKKfIcst
o7DUw1/hz2Ck4N5JrgUCQQCyKveNvjzkkd8HjYs0SwM0fPjK16//5qDZ2UiDGnOe
uEzxBDAr518Z8VFbR41in3W4Y3yCDgQlLlcETrS+zYcL
-----END RSA PRIVATE KEY-----`;
const RFC8463_MESSAGE = [
  'DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed;',
  ' d=football.example.com; i=@football.example.com;',
  ' q=dns/txt; s=brisbane; t=1528637909; h=from : to :',
  ' subject : date : message-id : from : subject : date;',
  ' bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;',
  ' b=/gCrinpcQOoIfuHNQIbq4pgh9kyIK3AQUdt9OdqQehSwhEIug4D11Bus',
  ' Fa3bT3FY5OsU7ZbnKELq+eXdp1Q1Dw==',
  'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;',
  ' d=football.example.com; i=@football.example.com;',
  ' q=dns/txt; s=test; t=1528637909; h=from : to : subject :',
  ' date : message-id : from : subject : date;',
  ' bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;',
  ' b=F45dVWDfMbQDGHJFlXUNB2HKfbCeLRyhDXgFpEL8GwpsRe0IeIixNTe3',
  ' DhCVlUrSjV4BwcVcOF6+FF3Zo9Rpo1tFOeS9mPYQTnGdaSGsgeefOsk2Jz',
  ' dA+L10TeYt9BgDfQNZtKdN1WO//KgIqXP7OdEFE4LjFYNcUxZQ4FADY+8=',
  'From: Joe SixPack <joe@football.example.com>',
  'To: Suzie Q <suzie@shopping.example.net>',
  'Subject: Is dinner ready?',
  'Date: Fri, 11 Jul 2003 21:00:37 -0700 (PDT)',
  'Message-ID: <20030712040037.46341.5F8J@football.example.com>',
  '',
  'Hi.',
  '',
  'We lost the game.  Are you hungry yet?',
  '',
  'Joe.',
  '',
].join('\r\n');

/** A 32-byte Ed25519 seed as a PKCS#8 private key. */
function ed25519FromSeed(seed: string): KeyObject {
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  return createPrivateKey({ key: Buffer.concat([prefix, Buffer.from(seed, 'base64')]), format: 'der', type: 'pkcs8' });
}

interface Signature {
  tags: Record<string, string>;
  raw: string;
}

function signatures(message: string): { fields: ReturnType<typeof parseHeaderFields>; body: string; sigs: Signature[] } {
  const split = message.indexOf('\r\n\r\n');
  const fields = parseHeaderFields(message.slice(0, split + 2));

  const sigs = fields
    .filter((f) => f.name.toLowerCase() === 'dkim-signature')
    .map((f) => {
      const value = f.raw.slice(f.raw.indexOf(':') + 1).replace(/\r\n/g, '');
      const tags = Object.fromEntries(
        value.split(';').filter((t) => t.trim()).map((t) => {
          const eq = t.indexOf('=');
          return [t.slice(0, eq).trim(), t.slice(eq + 1).replace(/\s+/g, '')];
        }),
      );
      return { tags, raw: f.raw };
    });

  return { fields, body: message.slice(split + 4), sigs };
}

/** A DKIM verifier (RFC 6376 §6.1.3), relaxed/relaxed only, with the public key given. */
function verifyDkim(message: string, publicKey: KeyObject, index = 0): { bodyHash: boolean; signature: boolean } {
  const { fields, body, sigs } = signatures(message);
  const sig = sigs[index];
  const bodyHash = createHash('sha256').update(relaxedBody(body)).digest('base64') === sig.tags.bh;

  const signed = sig.tags.h.split(':').map((h) => h.trim().toLowerCase());
  const used = new Map<string, number>();
  let data = '';
  for (const name of signed) {
    const matching = fields.filter((f) => f.name.toLowerCase() === name);
    const i = matching.length - 1 - (used.get(name) ?? 0);
    used.set(name, (used.get(name) ?? 0) + 1);
    if (i >= 0) {
      data += `${relaxedHeader(matching[i].raw)}\r\n`;
    }
  }
  data += relaxedHeader(sig.raw.replace(/(\bb=)[^;]*$/, '$1'));

  const b = Buffer.from(sig.tags.b, 'base64');
  const signature =
    sig.tags.a === 'ed25519-sha256'
      ? verify(null, createHash('sha256').update(data).digest(), publicKey, b)
      : verify('sha256', Buffer.from(data), publicKey, b);
  return { bodyHash, signature };
}

describe('DKIM against RFC 8463 Appendix A', () => {
  const ed25519 = ed25519FromSeed(ED25519_SEED);
  const rsa = createPrivateKey(RSA_KEY);

  it('derives the published Ed25519 public key from the seed', () => {
    const spki = createPublicKey(ed25519).export({ type: 'spki', format: 'der' });
    expect(spki.subarray(-32).toString('base64')).toBe(ED25519_PUBLIC);
  });

  it('computes the published body hash (relaxed body canonicalization)', () => {
    const { body, sigs } = signatures(RFC8463_MESSAGE);
    expect(createHash('sha256').update(relaxedBody(body)).digest('base64')).toBe(sigs[0].tags.bh);
  });

  it('reproduces both published signatures byte for byte (relaxed header canonicalization)', () => {
    const { fields, sigs } = signatures(RFC8463_MESSAGE);
    const h = (s: Signature) => s.tags.h.split(':').map((name) => name.trim().toLowerCase());

    // Ed25519 and RSA PKCS#1 v1.5 are deterministic: the same input gives the same b=
    expect(computeSignature(fields, h(sigs[0]), sigs[0].raw, 'ed25519-sha256', ed25519)).toBe(sigs[0].tags.b);
    expect(computeSignature(fields, h(sigs[1]), sigs[1].raw, 'rsa-sha256', rsa)).toBe(sigs[1].tags.b);
  });

  it('verifies both with the verifier used below', () => {
    expect(verifyDkim(RFC8463_MESSAGE, createPublicKey(ed25519), 0)).toEqual({ bodyHash: true, signature: true });
    expect(verifyDkim(RFC8463_MESSAGE, createPublicKey(rsa), 1)).toEqual({ bodyHash: true, signature: true });
  });
});

describe('DKIM signing', () => {
  async function message() {
    return createMailMessage(
      {
        to: [{ name: 'Zoë Łukasiewicz', address: 'zoe@example.com' }],
        subject: 'Zamówienie #42 — potwierdzenie',
        html: '<p>Dziękujemy!</p>'.repeat(20),
        attachments: [{ filename: 'faktura.pdf', content: Buffer.alloc(3000, 1) }],
        headers: { 'X-Order': '42' },
      },
      { from: 'Acme Books <orders@acme.example>' },
    );
  }

  it.each(['rsa', 'ed25519'] as const)('signs with %s so that a verifier accepts it', async (type) => {
    const { privateKey, publicKey } =
      type === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ed25519');
    const sign = createDkimSigner({ domainName: 'acme.example', keySelector: 'mail2026', privateKey }, 'SmtpTransport');

    const signed = sign((await message()).toMime(), Date.UTC(2026, 8, 22) ).toString('utf8');
    const { sigs } = signatures(signed);

    expect(sigs[0].tags).toMatchObject({
      v: '1',
      a: `${type}-sha256`,
      c: 'relaxed/relaxed',
      d: 'acme.example',
      s: 'mail2026',
      t: String(Date.UTC(2026, 8, 22) / 1000),
      h: 'from:reply-to:to:subject:date:message-id:mime-version:content-type:x-order:from'.replace('reply-to:', ''),
    });
    expect(signed.split('\r\n').every((line) => line.length <= 998)).toBe(true);
    expect(verifyDkim(signed, publicKey)).toEqual({ bodyHash: true, signature: true });

    // Tampering breaks it: the body, a signed header, or a From added above
    expect(verifyDkim(signed.replace('Dzi=C4=99kujemy', 'Dzi=C4=99kuj=65my'), publicKey).bodyHash).toBe(false);
    expect(verifyDkim(signed.replace('X-Order: 42', 'X-Order: 43'), publicKey).signature).toBe(false);
    const withSecondFrom = signed.replace(/\r\nFrom: /, '\r\nFrom: Mallory <m@evil.example>\r\nFrom: ');
    expect(verifyDkim(withSecondFrom, publicKey).signature).toBe(false);
  });

  it('signs Content-Transfer-Encoding when the message has one (a single-part body)', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const sign = createDkimSigner({ domainName: 'acme.example', keySelector: 's1', privateKey }, 'SmtpTransport');

    const plain = await createMailMessage({ to: 'a@example.com', subject: 'Hi', text: 'Hi there' }, { from: 'orders@acme.example' });
    const signed = sign(plain.toMime()).toString('utf8');

    expect(signatures(signed).sigs[0].tags.h).toBe('from:to:subject:date:message-id:content-type:content-transfer-encoding:from'.replace('content-type', 'mime-version:content-type'));
    expect(verifyDkim(signed, publicKey)).toEqual({ bodyHash: true, signature: true });
    expect(verifyDkim(signed.replace('Content-Transfer-Encoding: 7bit', 'Content-Transfer-Encoding: 8bit'), publicKey).signature).toBe(false);
  });

  it('survives what relaxed canonicalization forgives: refolding and trailing whitespace', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const sign = createDkimSigner({ domainName: 'acme.example', keySelector: 's1', privateKey }, 'SmtpTransport');
    const signed = sign((await message()).toMime()).toString('utf8');
    const refolded = signed.replace('Subject: ', 'Subject:   \r\n\t ').replace(/\r\n$/, '\r\n\r\n\r\n');
    expect(verifyDkim(refolded, publicKey)).toEqual({ bodyHash: true, signature: true });
  });

  it('fails at startup on bad options, without echoing the key', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const make = (options: object) => () =>
      createDkimSigner({ domainName: 'acme.example', keySelector: 's1', privateKey, ...options }, 'SmtpTransport');

    expect(make({ domainName: 'not a domain' })).toThrow(/dkim\.domainName/);
    expect(make({ keySelector: 'a b' })).toThrow(/dkim\.keySelector/);

    const secret = '-----BEGIN PRIVATE KEY-----\nc2VjcmV0LXZhbHVl\n-----END PRIVATE KEY-----';
    expect(make({ privateKey: secret })).toThrow(/dkim\.privateKey is not a valid PEM private key|`dkim\.privateKey` is not a valid/);
    try {
      make({ privateKey: secret })();
    } catch (error) {
      expect((error as Error).message).not.toContain('c2VjcmV0');
    }

    expect(make({ privateKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey })).toThrow(/RSA or Ed25519/);
    expect(make({ privateKey: generateKeyPairSync('rsa', { modulusLength: 512 }).privateKey })).toThrow(/shorter than 1024/);
    expect(make({ privateKey: generateKeyPairSync('ed25519').publicKey })).toThrow(/private key/);
  });
});
