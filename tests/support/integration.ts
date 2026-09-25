import { createHash, verify, type KeyObject } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeTransaction } from './fake-smtp-server.js';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  raw: string;
  json: any;
}

export type StubReply = { status: number; headers?: Record<string, string>; body?: unknown } | 'hang';

/**
 * A provider API on `node:http`, bound to 127.0.0.1 on a free port: it records every request
 * and answers with what `reply` returns (a JSON body when the body isn't a string).
 */
export class HttpProviderStub {
  readonly requests: RecordedRequest[] = [];
  reply: (request: RecordedRequest, index: number) => StubReply = () => ({ status: 200, body: {} });
  private server!: Server;

  get baseUrl(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async listen(): Promise<this> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }

      const raw = Buffer.concat(chunks).toString('utf8');
      const request = { method: req.method!, path: req.url!, headers: req.headers, raw, json: raw ? JSON.parse(raw) : undefined };
      this.requests.push(request);

      const answer = this.reply(request, this.requests.length - 1);
      if (answer === 'hang') {
        return;
      }

      const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {});
      const type = typeof answer.body === 'string' ? 'text/plain' : 'application/json';
      res.writeHead(answer.status, { 'content-type': type, ...answer.headers });
      res.end(body);
    });

    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** The message as the SMTP server received it, with the line break that ended its last line. */
export function received(transaction: FakeTransaction): string {
  return `${transaction.data}\r\n`;
}

interface HeaderField {
  name: string;
  raw: string;
}

function headerFields(head: string): HeaderField[] {
  const fields: HeaderField[] = [];
  for (const line of head.split('\r\n')) {
    if (/^[ \t]/.test(line) && fields.length) {
      fields[fields.length - 1].raw += `\r\n${line}`;
    } else if (line) {
      fields.push({ name: line.slice(0, line.indexOf(':')).trim().toLowerCase(), raw: line });
    }
  }
  return fields;
}

/** RFC 6376 §3.4.2. */
function relaxedHeader(raw: string): string {
  const colon = raw.indexOf(':');
  const value = raw.slice(colon + 1).replace(/\r\n/g, '').replace(/[ \t]+/g, ' ').trim();
  return `${raw.slice(0, colon).trim().toLowerCase()}:${value}`;
}

/** RFC 6376 §3.4.4. */
function relaxedBody(body: string): string {
  const lines = body.split('\r\n').map((line) => line.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.length ? `${lines.join('\r\n')}\r\n` : '';
}

/**
 * Verifies the message's DKIM-Signature as a receiving MTA does (RFC 6376 §6.1.3, relaxed
 * canonicalization only), with the public key a DNS lookup of `s=` would return. Written
 * from the RFC, independently of the signer.
 */
export function verifyDkim(message: string, publicKey: KeyObject): { tags: Record<string, string>; bodyHash: boolean; signature: boolean } {
  const split = message.indexOf('\r\n\r\n');
  const fields = headerFields(message.slice(0, split));
  const field = fields.find((f) => f.name === 'dkim-signature');
  if (!field) {
    throw new Error('no DKIM-Signature');
  }

  const value = field.raw.slice(field.raw.indexOf(':') + 1);
  const tags = Object.fromEntries(
    value
      .split(';')
      .filter((tag) => tag.trim())
      .map((tag) => [tag.slice(0, tag.indexOf('=')).trim(), tag.slice(tag.indexOf('=') + 1).replace(/\s+/g, '')]),
  );

  const bodyHash = createHash('sha256').update(relaxedBody(message.slice(split + 4))).digest('base64') === tags.bh;

  const used = new Map<string, number>();
  let data = '';
  for (const name of tags.h.split(':').map((h) => h.toLowerCase())) {
    const matching = fields.filter((f) => f.name === name);
    const index = matching.length - 1 - (used.get(name) ?? 0);
    used.set(name, (used.get(name) ?? 0) + 1);
    if (index >= 0) {
      data += `${relaxedHeader(matching[index].raw)}\r\n`;
    }
  }
  data += relaxedHeader(field.raw.replace(/((?:^|;)\s*b\s*=)[^;]*/, '$1'));

  const b = Buffer.from(tags.b, 'base64');
  const signature =
    tags.a === 'ed25519-sha256'
      ? verify(null, createHash('sha256').update(data).digest(), publicKey, b)
      : verify('sha256', Buffer.from(data), publicKey, b);

  return { tags, bodyHash, signature };
}

/** Lets pending I/O callbacks and promise jobs run, a few rounds of the event loop. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
