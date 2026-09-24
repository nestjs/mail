import { Body, Controller, HttpCode, Injectable, Module, Post, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import request from 'supertest';
import { adapters, createApp } from './support/adapters.js';
import {
  html,
  InMemoryMailTransport,
  type Mailable,
  Mailer,
  MailModule,
  MailTransport,
  SmtpTransport,
} from '../lib/index.js';
import { FakeSmtpServer } from './support/fake-smtp-server.js';
import { header, parseMessage } from './support/mime-parser.js';

const SECRET = 'test-secret-that-is-at-least-32-chars';

/** A signed, expiring token: the shape a password-reset or email-verification flow sends. */
function signToken(email: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ email, expiresAt })).toString('base64url');
  return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
}

function verifyToken(token: string): string | undefined {
  const [payload, signature] = token.split('.');
  const expected = createHmac('sha256', SECRET).update(payload ?? '').digest();
  const given = Buffer.from(signature ?? '', 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return undefined;
  }

  const { email, expiresAt } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return expiresAt > Date.now() ? email : undefined;
}

@Injectable()
class PasswordResetMail implements Mailable<{ url: string; name: string }> {
  render({ url, name }: { url: string; name: string }) {
    return {
      subject: 'Reset your password',
      html: html`<p>Hi ${name},</p><p><a href="${url}">Choose a new password</a></p><p>The link expires in 30 minutes.</p>`,
    };
  }
}

@Controller('password-resets')
class PasswordResetsController {
  constructor(private readonly mailer: Mailer) {}

  @Post()
  @HttpCode(202)
  async request(@Body() body: { email: string; name: string }) {
    const url = new URL('https://acme.example/reset-password');
    url.searchParams.set('token', signToken(body.email, Date.now() + 30 * 60_000));
    url.searchParams.set('lang', 'en&pl'); // escaped as &amp; in the HTML, decoded again by link()
    await this.mailer.send(PasswordResetMail, { to: { name: body.name, address: body.email }, data: { url: url.href, name: body.name } });
  }

  @Post('confirm')
  @HttpCode(200)
  confirm(@Body() body: { token: string }) {
    const email = verifyToken(body.token);
    if (!email) {
      throw new UnauthorizedException();
    }
    return { email };
  }
}

@Module({
  imports: [MailModule.forRoot({ transport: new SmtpTransport({ host: 'smtp.acme.example' }), from: 'Acme Books <no-reply@acme.example>' })],
  controllers: [PasswordResetsController],
  providers: [PasswordResetMail],
})
class AppModule {}

describe.each(adapters)('a signed link sent by mail ($name)', ({ name }) => {
  let app: INestApplication;
  let mailbox: InMemoryMailTransport;

  beforeEach(async () => {
    mailbox = new InMemoryMailTransport();
    app = await createApp(name, AppModule, { override: (builder) => builder.overrideProvider(MailTransport).useValue(mailbox) });
  });
  afterEach(() => app.close());

  it('is found in the mail and works once followed', async () => {
    await request(app.getHttpServer())
      .post('/password-resets')
      .send({ email: 'ada@example.com', name: 'Ada <3' })
      .expect(202);

    const mail = mailbox.assertSent({ to: 'ada@example.com', mail: PasswordResetMail });
    expect(mail.html).toContain('Hi Ada &lt;3,');

    const link = mail.link('/reset-password');
    expect(link.searchParams.get('lang')).toBe('en&pl');
    // The text part carries the same link, for clients that show text
    expect(mail.text).toContain(link.href);

    await request(app.getHttpServer())
      .post('/password-resets/confirm')
      .send({ token: link.searchParams.get('token') })
      .expect(200, { email: 'ada@example.com' });

    await request(app.getHttpServer()).post('/password-resets/confirm').send({ token: `${link.searchParams.get('token')}x` }).expect(401);
  });
});

describe.each(adapters)('an app sending through a real SMTP exchange ($name)', ({ name }) => {
  let app: INestApplication;
  let server: FakeSmtpServer;

  beforeEach(async () => {
    server = await new FakeSmtpServer({ users: { mailer: 'secret' } }).listen();

    const transport = new SmtpTransport({
      host: '127.0.0.1',
      port: server.port,
      startTls: 'required',
      tls: { ca: server.certificate.cert },
      auth: { user: 'mailer', pass: 'secret' },
      pool: true,
    });
    app = await createApp(name, AppModule, { override: (builder) => builder.overrideProvider(MailTransport).useValue(transport) });
  });
  afterEach(async () => {
    await app.close();
    await server.close();
  });

  it('delivers the mail over STARTTLS, and quits the pooled connection on shutdown', async () => {
    await request(app.getHttpServer()).post('/password-resets').send({ email: 'ada@example.com', name: 'Ada' }).expect(202);

    expect(server.transactions).toHaveLength(1);
    const parsed = parseMessage(`${server.transactions[0].data}\r\n`);
    expect(header(parsed.headers, 'subject')).toBe('Reset your password');
    expect(server.transactions[0]).toMatchObject({ secure: true, user: 'mailer', to: ['ada@example.com'] });

    await app.close();
    expect(server.sessions[0].commands.at(-1)).toBe('QUIT');
  });
});
