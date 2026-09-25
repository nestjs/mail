import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * A self-signed ECDSA P-256 certificate for `localhost` and `127.0.0.1`, built at test
 * time with `node:crypto` and a few lines of DER: no openssl binary, no fixture that
 * expires. Returns PEM strings for `tls.createServer()` and the client's `ca`.
 */
export function selfSignedCertificate(commonName = 'localhost'): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecdsaWithSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(set(seq(oid('2.5.4.3'), utf8(commonName))));
  const now = Date.now();
  // DER integers are minimal: a serial starting with 0x00 then a byte below 0x80 is "illegal
  // padding" to OpenSSL, which made about one certificate in 512 unusable
  const serial = randomBytes(8);
  serial[0] = (serial[0] & 0x7f) | 0x01;

  const tbs = seq(
    explicit(0, int(Buffer.from([2]))),
    int(serial),
    ecdsaWithSha256,
    name,
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(
      3,
      seq(
        // subjectAltName: DNS:localhost, IP:127.0.0.1
        seq(oid('2.5.29.17'), octet(seq(tlv(0x82, Buffer.from('localhost')), tlv(0x87, Buffer.from([127, 0, 0, 1]))))),
        // basicConstraints: CA:TRUE, so the certificate can be its own trust anchor
        seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), octet(seq(tlv(0x01, Buffer.from([0xff]))))),
      ),
    ),
  );

  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, ecdsaWithSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    cert: `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}

function tlv(tag: number, content: Buffer): Buffer {
  const length =
    content.length < 128
      ? Buffer.from([content.length])
      : (() => {
          const bytes: number[] = [];
          for (let n = content.length; n > 0; n >>= 8) {
            bytes.unshift(n & 0xff);
          }
          return Buffer.from([0x80 | bytes.length, ...bytes]);
        })();

  return Buffer.concat([Buffer.from([tag]), length, content]);
}

const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const octet = (content: Buffer) => tlv(0x04, content);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
const explicit = (n: number, content: Buffer) => tlv(0xa0 + n, content);

function int(value: Buffer): Buffer {
  return tlv(0x02, value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a * 40 + b];
  for (const n of rest) {
    const part = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) {
      part.unshift((v & 0x7f) | 0x80);
    }
    bytes.push(...part);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const iso = date.toISOString(); // 2026-09-22T18:04:05.123Z
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(text));
}
