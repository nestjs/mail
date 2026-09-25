import { Body, Controller, Module, Post, type INestApplication, type LoggerService } from '@nestjs/common';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import {
  FileMailTransport,
  html,
  InMemoryMailTransport,
  LogMailTransport,
  Mailer,
  MailModule,
  type MailSendOptions,
  type MailTransport,
} from '../lib/index.js';
import { decodeWords, header, lint, parseAddresses, parseContentType, parseMessage } from './support/mime-parser.js';

@Controller('mail')
class MailController {
  constructor(private readonly mailer: Mailer) {}

  @Post()
  send(@Body() body: Pick<MailSendOptions, 'to' | 'bcc' | 'subject'>) {
    return this.mailer.send({
      ...body,
      html: html`<p>Sign in: <a href="${'https://shop.example.com/magic?token=abc&next=/orders'}">link</a></p>`,
      attachments: [{ filename: 'notatka-ł.txt', content: 'Zażółć' }],
    });
  }
}

function appModule(transport: MailTransport) {
  @Module({ imports: [MailModule.forRoot({ transport, from: 'Orders <orders@example.com>' })], controllers: [MailController] })
  class AppModule {}
  return AppModule;
}

class RecordingLogger implements LoggerService {
  readonly lines: [level: string, message: string, context?: string][] = [];
  log(message: string, context?: string) {
    this.lines.push(['log', message, context]);
  }
  warn(message: string, context?: string) {
    this.lines.push(['warn', message, context]);
  }
  error(message: string, context?: string) {
    this.lines.push(['error', message, context]);
  }
  debug(message: string, context?: string) {
    this.lines.push(['debug', message, context]);
  }
}

describe.each(adapters)('development transports in an app ($name)', ({ name }) => {
  let app: INestApplication | undefined;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mail-eml-'));
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('FileMailTransport writes each mail as an .eml file a mail client opens, and logs where', async () => {
    const logger = new RecordingLogger();
    app = await createApp(name, appModule(new FileMailTransport({ directory: dir })), { setup: (app) => app.useLogger(logger) });

    const { body } = await request(app.getHttpServer())
      .post('/mail')
      .send({ to: 'Zoë <zoe@example.com>', bcc: 'audit@example.com', subject: 'Twój link logowania' })
      .expect(201);

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-[\w-]+-[0-9a-f]{6}\.eml$/);
    expect(body).toMatchObject({ accepted: ['zoe@example.com', 'audit@example.com'], response: join(dir, files[0]) });

    const raw = readFileSync(join(dir, files[0]), 'utf8');
    expect(lint(raw)).toEqual([]);
    const message = parseMessage(raw);
    expect(decodeWords(header(message.headers, 'subject')!)).toBe('Twój link logowania');
    expect(parseAddresses(header(message.headers, 'to')!)).toEqual([{ name: 'Zoë', address: 'zoe@example.com' }]);
    expect(header(message.headers, 'message-id')).toBe(body.messageId);
    expect(raw).not.toContain('audit@example.com');
    const [alternative, note] = message.parts;
    expect(alternative.parts[1].body.toString()).toContain('href="https://shop.example.com/magic?token=abc&amp;next=/orders"');
    expect(parseContentType(header(note.headers, 'content-disposition')!)[1].filename).toBe('notatka-ł.txt');
    expect(note.body.toString()).toBe('Zażółć');

    expect(logger.lines).toContainEqual(['log', expect.stringContaining(`"Twój link logowania" to zoe@example.com, audit@example.com written to`), 'FileMailTransport']);
  });

  it('LogMailTransport logs recipients, subject and attachments, and the text (with its links) at debug', async () => {
    const logger = new RecordingLogger();
    app = await createApp(name, appModule(new LogMailTransport({ logger })), { setup: (app) => app.useLogger(false) });

    await request(app.getHttpServer()).post('/mail').send({ to: 'ada@example.com', subject: 'Sign in' }).expect(201);

    expect(logger.lines).toEqual([
      ['log', '"Sign in" to ada@example.com with 1 attachment(s): notatka-ł.txt', undefined],
      ['debug', 'Sign in: link (https://shop.example.com/magic?token=abc&next=/orders)', undefined],
    ]);
  });

  it.each([
    ['InMemoryMailTransport', () => new InMemoryMailTransport()],
    ['LogMailTransport', () => new LogMailTransport({ logger: new RecordingLogger() })],
  ])('warns once at startup in production when the transport is %s, which delivers nothing', async (transportName, transport) => {
    vi.stubEnv('NODE_ENV', 'production');
    const logger = new RecordingLogger();
    app = await createApp(name, appModule(transport()), { setup: (app) => app.useLogger(logger) });

    const warnings = logger.lines.filter(([level, , context]) => level === 'warn' && context === 'MailModule');
    expect(warnings).toEqual([['warn', expect.stringContaining(`The mail transport is ${transportName}, which doesn't deliver mail`), 'MailModule']]);
  });
});
