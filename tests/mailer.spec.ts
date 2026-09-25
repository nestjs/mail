import { Global, Inject, Injectable, Logger, Module, type LoggerService } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstValueFrom, toArray } from 'rxjs';
import {
  FileMailTransport,
  html,
  InMemoryMailTransport,
  LogMailTransport,
  MAIL_MODULE_OPTIONS,
  type Mailable,
  MailConnectionError,
  Mailer,
  MailError,
  type MailEvent,
  MailEvents,
  type MailMessage,
  MailMessageError,
  MailModule,
  type MailModuleOptions,
  type MailOptionsFactory,
  type MailRenderContext,
  type MailSentEvent,
  MailSmtpError,
  MailTransport,
  type MailTransportSendOptions,
  SmtpTransport,
} from '../lib/index.js';
import { parseMessage } from './support/mime-parser.js';

const FROM = 'Orders <orders@example.com>';
const CONFIG = Symbol('CONFIG');

@Global()
@Module({ providers: [{ provide: CONFIG, useValue: { shopUrl: 'https://shop.example.com' } }], exports: [CONFIG] })
class ConfigModule {}

@Injectable()
class Greeter {
  greet(name: string) {
    return `Hello, ${name}`;
  }
}

interface Order {
  id: number;
  customer: string;
  items: { title: string; quantity: number }[];
}

/** A mail class registered as a provider of its feature module: it injects that module's Greeter. */
@Injectable()
class OrderConfirmationMail implements Mailable<Order> {
  constructor(
    private readonly greeter: Greeter,
    @Inject(CONFIG) private readonly config: { shopUrl: string },
  ) {}

  render(order: Order, { locale }: MailRenderContext) {
    const url = `${this.config.shopUrl}/orders/${order.id}`;
    return {
      subject: locale === 'pl' ? `Zamówienie #${order.id}` : `Order #${order.id}`,
      html: html`<p>${this.greeter.greet(order.customer)}</p>
        <ul>${order.items.map((item) => html`<li>${item.title} × ${item.quantity}</li>`)}</ul>
        <p><a href="${url}">View your order</a></p>`,
      headers: { 'X-Order-Id': String(order.id) },
    };
  }
}

@Module({ providers: [Greeter, OrderConfirmationMail] })
class OrdersModule {}

/** Not a provider anywhere, no dependencies. */
class WelcomeMail implements Mailable {
  render() {
    return { subject: 'Welcome', text: 'Welcome to the store' };
  }
}

/** Not a provider anywhere, but its dependency is global: created in MailModule's scope. */
@Injectable()
class NewsletterMail implements Mailable<{ issue: number }> {
  constructor(@Inject(CONFIG) private readonly config: { shopUrl: string }) {}
  render({ issue }: { issue: number }) {
    return { subject: `Newsletter #${issue}`, html: html`<a href="${this.config.shopUrl}/n/${issue}">Read</a>` };
  }
}

/** A transport that fails as scripted, then records what it sends. */
class ScriptedTransport extends MailTransport {
  readonly calls: { message: MailMessage; options: MailTransportSendOptions }[] = [];
  closed = false;
  constructor(private readonly failures: unknown[] = []) {
    super();
  }
  async send(message: MailMessage, options: MailTransportSendOptions) {
    this.calls.push({ message, options });
    const failure = this.failures.shift();
    if (failure) {
      throw failure;
    }
    return { providerMessageId: `p-${this.calls.length}` };
  }
  close() {
    this.closed = true;
  }
}

const transient = () => new MailSmtpError('MAIL FROM', { code: 451, enhancedCode: '4.7.1', text: 'Try again later' });
const permanent = () => new MailSmtpError('RCPT TO', { code: 550, enhancedCode: '5.1.1', text: 'No such user' });
const noWait = { backoff: { delay: 0 } };

describe('MailModule and Mailer', () => {
  let moduleRef: TestingModule | undefined;
  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  async function compile(imports: unknown[]) {
    moduleRef = await Test.createTestingModule({ imports: imports as never[] }).compile();
    await moduleRef.init();
    return moduleRef;
  }

  describe('registration', () => {
    it('forRoot() takes a transport instance and defaults, and is global', async () => {
      const mailbox = new InMemoryMailTransport();
      await compile([ConfigModule, MailModule.forRoot({ transport: mailbox, from: FROM, replyTo: 'help@example.com' }), OrdersModule]);

      expect(moduleRef!.get(MailTransport)).toBe(mailbox);
      expect(moduleRef!.get(MAIL_MODULE_OPTIONS)).toMatchObject({ from: FROM });

      const result = await moduleRef!.get(Mailer).send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' });
      expect(result).toMatchObject({ accepted: ['ada@example.com'], attempts: 1, messageId: expect.stringMatching(/@example\.com>$/) });

      const mail = mailbox.assertSent({ to: 'ADA@example.com', subject: 'Hi' });
      expect(mail.from).toEqual({ name: 'Orders', address: 'orders@example.com' });
      expect(mail.message.replyTo).toEqual([{ address: 'help@example.com' }]);
    });

    it('fails when there is no transport, naming the option', async () => {
      expect(() => MailModule.forRoot({ from: FROM } as never)).toThrow(/MailModule needs a `transport`/);
      await expect(
        Test.createTestingModule({ imports: [MailModule.forRootAsync({ useFactory: () => ({ from: FROM }) })] }).compile(),
      ).rejects.toThrow(/MailModule needs a `transport`/);
    });

    it('forRootAsync(): the factory returns an instance built from configuration', async () => {
      await compile([
        ConfigModule,
        MailModule.forRootAsync({
          inject: [CONFIG],
          useFactory: (config: { shopUrl: string }) => ({
            transport: new InMemoryMailTransport(),
            from: `Orders <orders@${new URL(config.shopUrl).host}>`,
          }),
        }),
      ]);

      await moduleRef!.get(Mailer).send({ to: 'a@example.com', subject: 's', text: 't' });
      expect((moduleRef!.get(MailTransport) as InMemoryMailTransport).assertSent().from.address).toBe('orders@shop.example.com');
    });

    it('forRootAsync(): a transport class at the top level is instantiated with DI', async () => {
      @Injectable()
      class ConfiguredTransport extends InMemoryMailTransport {
        constructor(@Inject(CONFIG) readonly config: { shopUrl: string }) {
          super();
        }
      }
      class Options implements MailOptionsFactory {
        createMailOptions(): MailModuleOptions {
          return { from: FROM, retry: false };
        }
      }

      await compile([ConfigModule, MailModule.forRootAsync({ transport: ConfiguredTransport, useClass: Options })]);
      expect((moduleRef!.get(MailTransport) as ConfiguredTransport).config.shopUrl).toBe('https://shop.example.com');
    });

    it('forRootAsync(): a class returned by the factory, or a transport set twice, fails at startup', async () => {
      await expect(
        Test.createTestingModule({
          imports: [MailModule.forRootAsync({ useFactory: () => ({ transport: InMemoryMailTransport as never }) })],
        }).compile(),
      ).rejects.toThrow(/returned a class as `transport` \(InMemoryMailTransport\)/);

      await expect(
        Test.createTestingModule({
          imports: [
            MailModule.forRootAsync({ transport: new InMemoryMailTransport(), useFactory: () => ({ transport: new InMemoryMailTransport() }) }),
          ],
        }).compile(),
      ).rejects.toThrow(/set both at the top level/);
    });

    it.each([
      [{ from: 'not an address' }, /MailModule: Invalid mail: from/],
      [{ replyTo: ['a@example.com', 'b@'] }, /MailModule: Invalid mail: replyTo\[1\]/],
      [{ headers: { 'X-Bad': 'a\r\nb' } }, /MailModule: Invalid mail: headers\.X-Bad/],
      [{ retry: { attempts: 0 } }, /MailModule: retry\.attempts/],
      [{ retry: { backoff: { delay: 'soon' } } }, /MailModule: retry\.backoff\.delay/],
    ])('fails at startup on invalid defaults: %j', async (options, message) => {
      await expect(
        Test.createTestingModule({ imports: [MailModule.forRoot({ transport: new InMemoryMailTransport(), ...(options as object) })] }).compile(),
      ).rejects.toThrow(message);
    });

    it('warns at startup when a transport that delivers nothing runs in production', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const env = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';

        await compile([MailModule.forRoot({ transport: new LogMailTransport(), from: FROM })]);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/LogMailTransport, which doesn't deliver mail/));

        await moduleRef!.close();
        warn.mockClear();

        await compile([MailModule.forRoot({ transport: new SmtpTransport({ host: 'smtp.example.com' }), from: FROM })]);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        process.env.NODE_ENV = env;
        warn.mockRestore();
      }
    });
  });

  describe('mail classes', () => {
    let mailbox: InMemoryMailTransport;
    beforeEach(async () => {
      mailbox = new InMemoryMailTransport();
      await compile([ConfigModule, MailModule.forRoot({ transport: mailbox, from: FROM }), OrdersModule]);
    });

    const order: Order = { id: 42, customer: 'Zoë <script>', items: [{ title: 'Dune & Co', quantity: 2 }] };

    it('renders with the provider from its own module, in the given locale', async () => {
      await moduleRef!.get(Mailer).send(OrderConfirmationMail, { to: 'zoe@example.com', data: order, locale: 'pl' });

      const mail = mailbox.assertSent({ mail: OrderConfirmationMail, to: 'zoe@example.com' });
      expect(mail.subject).toBe('Zamówienie #42');
      expect(mail.locale).toBe('pl');
      expect(mail.html).toContain('<p>Hello, Zoë &lt;script&gt;</p>');
      expect(mail.html).toContain('<li>Dune &amp; Co × 2</li>');
      expect(mail.text).toContain('Hello, Zoë <script>');
      expect(mail.text).toContain('- Dune & Co × 2');
      expect(mail.headers).toEqual({ 'X-Order-Id': '42' });
      expect(mail.link('/orders/').pathname).toBe('/orders/42');
      expect(mail.links).toEqual(['https://shop.example.com/orders/42']);
    });

    it('creates mail classes that are not providers', async () => {
      const mailer = moduleRef!.get(Mailer);
      await mailer.send(WelcomeMail, { to: 'a@example.com' });
      await mailer.send(NewsletterMail, { to: 'a@example.com', data: { issue: 7 } });

      expect(mailbox.filter().map((m) => [m.subject, m.mail])).toEqual([
        ['Welcome', WelcomeMail],
        ['Newsletter #7', NewsletterMail],
      ]);
      expect(mailbox.assertSent({ mail: NewsletterMail }).link().href).toBe('https://shop.example.com/n/7');
    });

    it('lets send() override and extend what render() returned', async () => {
      await moduleRef!.get(Mailer).send(OrderConfirmationMail, {
        to: [{ name: 'Zoë', address: 'zoe@example.com' }],
        bcc: 'audit@example.com',
        from: 'Support <support@example.com>',
        data: order,
        attachments: [{ filename: 'invoice-42.pdf', content: Buffer.from('%PDF') }],
        headers: { 'X-Campaign': 'none' },
      });

      const mail = mailbox.assertSent();
      expect(mail.from.address).toBe('support@example.com');
      expect(mail.bcc).toEqual([{ address: 'audit@example.com' }]);
      expect(mail.attachment('invoice-42.pdf').contentType).toBe('application/pdf');
      expect(mail.headers).toEqual({ 'X-Order-Id': '42', 'X-Campaign': 'none' });
      expect(parseMessage(mail.raw).type).toBe('multipart/mixed');
    });

    it('render() previews a mail without recipients; send() needs one', async () => {
      const mailer = moduleRef!.get(Mailer);
      const preview = await mailer.render(OrderConfirmationMail, { data: order });

      expect(preview.subject).toBe('Order #42');
      expect(preview.to).toEqual([]);
      await expect(mailer.send(OrderConfirmationMail, { data: order })).rejects.toThrow(MailMessageError);
      expect(mailbox.mails).toEqual([]);
    });

    it('rejects a class that is not a mail class, and bad render() results', async () => {
      const mailer = moduleRef!.get(Mailer);
      await expect(mailer.send(Greeter as never, { to: 'a@example.com' } as never)).rejects.toThrow(/not a mail class/);

      class Broken implements Mailable {
        render() {
          return undefined as never;
        }
      }
      await expect(mailer.send(Broken, { to: 'a@example.com' })).rejects.toThrow(/must return \{ subject/);
    });

    it('types data from the mail class', () => {
      const mailer = moduleRef!.get(Mailer);
      const check = () => {
        // @ts-expect-error data is required for OrderConfirmationMail
        void mailer.send(OrderConfirmationMail, { to: 'a@example.com' });
        // @ts-expect-error data has the wrong shape
        void mailer.send(OrderConfirmationMail, { to: 'a@example.com', data: { id: 'x' } });
        void mailer.send(WelcomeMail, { to: 'a@example.com' });
      };
      expect(check).toBeTypeOf('function');
    });
  });

  describe('retries and events', () => {
    async function setup(transport: MailTransport, retry: MailModuleOptions['retry'] = { attempts: 3, ...noWait }) {
      await compile([MailModule.forRoot({ transport, from: FROM, retry })]);
      const events: MailEvent[] = [];
      moduleRef!.get(MailEvents).events$.subscribe((e) => events.push(e));
      return { mailer: moduleRef!.get(Mailer), events };
    }
    const mail = { to: 'ada@example.com', subject: 'Order #42', text: 'x' };

    it('retries transient failures and reports the attempts', async () => {
      const transport = new ScriptedTransport([transient(), new MailConnectionError('reset', { permanent: false })]);
      const { mailer, events } = await setup(transport);
      const result = await mailer.send({ ...mail, idempotencyKey: 'outbox:1' });

      expect(result).toMatchObject({ attempts: 3, providerMessageId: 'p-3' });
      expect(transport.calls.map((c) => [c.options.attempt, c.options.idempotencyKey])).toEqual([
        [1, 'outbox:1'],
        [2, 'outbox:1'],
        [3, 'outbox:1'],
      ]);
      // The same message every attempt: one Message-ID
      expect(new Set(transport.calls.map((c) => c.message.messageId)).size).toBe(1);
      expect(events).toEqual([
        {
          type: 'sent',
          messageId: result.messageId,
          recipients: ['ada@example.com'],
          subject: 'Order #42',
          transport: 'ScriptedTransport',
          attempts: 3,
          durationMs: expect.any(Number),
          providerMessageId: 'p-3',
        },
      ]);
    });

    it('does not retry a permanent failure, and publishes failed', async () => {
      const error = permanent();
      const transport = new ScriptedTransport([error]);
      const { mailer, events } = await setup(transport);

      await expect(mailer.send(mail)).rejects.toBe(error);
      expect(transport.calls).toHaveLength(1);
      expect(events).toEqual([expect.objectContaining({ type: 'failed', attempts: 1, permanent: true, error })]);
    });

    it('does not retry an error with a 4xx status, nor past `attempts`', async () => {
      const caller = Object.assign(new Error('bad input'), { status: 422 });
      const t1 = new ScriptedTransport([caller]);

      await expect((await setup(t1)).mailer.send(mail)).rejects.toBe(caller);
      expect(t1.calls).toHaveLength(1);
      await moduleRef!.close();

      const t2 = new ScriptedTransport([transient(), transient(), transient(), transient()]);
      const { mailer, events } = await setup(t2);

      await expect(mailer.send(mail)).rejects.toBeInstanceOf(MailSmtpError);
      expect(t2.calls).toHaveLength(3);
      expect(events).toEqual([expect.objectContaining({ type: 'failed', attempts: 3, permanent: false })]);
    });

    it('honors retry: false, per-send overrides, retryIf and backoff functions', async () => {
      const transport = new ScriptedTransport([transient(), transient(), transient()]);
      const { mailer } = await setup(transport, false);

      await expect(mailer.send(mail)).rejects.toThrow(MailSmtpError);
      expect(transport.calls).toHaveLength(1);

      const waits: number[] = [];
      const result = await mailer.send({
        ...mail,
        retry: { attempts: 5, backoff: (attempt) => (waits.push(attempt), 1), retryIf: (_e, attempt) => attempt < 3 },
      });

      expect(result.attempts).toBe(3);
      expect(waits).toEqual([1, 2]);
      await expect(mailer.send({ ...mail, retry: { attempts: 0 } })).rejects.toThrow(/Mailer\.send\(\): retry\.attempts/);
    });

    it('ends the send with a failed event when retryIf or backoff throws', async () => {
      const transport = new ScriptedTransport([transient(), transient()]);
      const { mailer, events } = await setup(transport);
      const bug = new TypeError('retryIf is broken');

      await expect(
        mailer.send({
          ...mail,
          retry: {
            attempts: 3,
            retryIf: () => {
              throw bug;
            },
          },
        }),
      ).rejects.toBe(bug);

      expect(transport.calls).toHaveLength(1);
      expect(events).toEqual([expect.objectContaining({ type: 'failed', attempts: 1, error: bug })]);

      const badBackoff = new RangeError('no delay');

      await expect(
        mailer.send({
          ...mail,
          retry: {
            attempts: 3,
            backoff: () => {
              throw badBackoff;
            },
          },
        }),
      ).rejects.toBe(badBackoff);

      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ type: 'failed', error: badBackoff });
    });

    it('stops waiting between attempts when the caller aborts', async () => {
      const transport = new ScriptedTransport([transient(), transient()]);
      const { mailer, events } = await setup(transport, { attempts: 3, backoff: { delay: '1m', jitter: 'none' } });
      const controller = new AbortController();
      const reason = new Error('request closed');

      const sending = mailer.send({ ...mail, signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort(reason);

      await expect(sending).rejects.toBe(reason);
      expect(transport.calls).toHaveLength(1);
      expect(events).toEqual([expect.objectContaining({ type: 'failed', error: reason })]);
    });

    it('publishes on the nestjs:mail diagnostics channels', async () => {
      const seen: unknown[] = [];
      const listener = (event: unknown) => seen.push(event);
      subscribe('nestjs:mail:sent', listener);
      subscribe('nestjs:mail:failed', listener);

      try {
        const { mailer } = await setup(new ScriptedTransport([permanent()]));
        await mailer.send(mail).catch(() => {});
        await mailer.send(mail);

        expect(seen.map((e) => (e as MailEvent).type)).toEqual(['failed', 'sent']);
      } finally {
        unsubscribe('nestjs:mail:sent', listener);
        unsubscribe('nestjs:mail:failed', listener);
      }
    });

    it('does not start a send for an invalid message', async () => {
      const transport = new ScriptedTransport();
      const { mailer, events } = await setup(transport);

      await expect(mailer.send({ ...mail, to: 'Eve <eve@evil.example>, ada@example.com' })).rejects.toThrow(MailMessageError);
      const error = await mailer.send({ ...mail, subject: 'x\r\nBcc: eve@evil.example' }).catch((e) => e);
      expect(error).toMatchObject({ status: 400, permanent: true, field: 'subject' });
      expect(error).toBeInstanceOf(MailError);
      expect(transport.calls).toEqual([]);
      expect(events).toEqual([]);
    });
  });

  describe('shutdown', () => {
    it('waits for sends in flight, then closes the transport and completes events$', async () => {
      let release!: () => void;
      class SlowTransport extends ScriptedTransport {
        override async send(message: MailMessage, options: MailTransportSendOptions) {
          await new Promise<void>((resolve) => (release = resolve));
          return super.send(message, options);
        }
      }

      const transport = new SlowTransport();
      await compile([MailModule.forRoot({ transport, from: FROM })]);
      const events = firstValueFrom(moduleRef!.get(MailEvents).events$.pipe(toArray()));
      const sending = moduleRef!.get(Mailer).send({ to: 'a@example.com', subject: 's', text: 't' });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const closing = moduleRef!.close();
      moduleRef = undefined;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(transport.closed).toBe(false);

      release();
      await closing;

      await expect(sending).resolves.toMatchObject({ attempts: 1 });
      expect(transport.closed).toBe(true);
      expect((await events).map((e) => (e as MailSentEvent).type)).toEqual(['sent']);
    });
  });

  describe('testing an app that sends mail', () => {
    it('swaps the configured transport for the in-memory one with overrideProvider()', async () => {
      @Module({
        imports: [
          ConfigModule,
          MailModule.forRoot({ transport: new SmtpTransport({ host: 'smtp.example.com', auth: { user: 'u', pass: 'p' } }), from: FROM }),
          OrdersModule,
        ],
      })
      class AppModule {}

      const mailbox = new InMemoryMailTransport();
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MailTransport).useValue(mailbox).compile();
      await moduleRef.init();

      await moduleRef.get(Mailer).send(OrderConfirmationMail, { to: 'zoe@example.com', data: { id: 7, customer: 'Zoë', items: [] } });
      expect(mailbox.assertSent({ mail: OrderConfirmationMail }).link(/orders\/\d+/).pathname).toBe('/orders/7');
      expect(() => mailbox.assertSent({ to: 'nobody@example.com' })).toThrow(
        /Expected a mail to nobody@example\.com, but none was sent\. Sent:\n {2}- "Order #7" to zoe@example\.com \(OrderConfirmationMail\)/,
      );
      expect(() => mailbox.assertNotSent({ mail: OrderConfirmationMail })).toThrow(/Expected no mail rendered by OrderConfirmationMail/);
      expect(() => mailbox.assertSent().link('/reset')).toThrow(/No link matching \/reset in the mail "Order #7"\. Links: https:\/\/shop\.example\.com\/orders\/7/);

      mailbox.failNext(new MailSmtpError('DATA', { code: 554, text: 'Rejected' }));
      await expect(moduleRef.get(Mailer).send({ to: 'a@example.com', subject: 's', text: 't' })).rejects.toThrow(/554/);
      mailbox.clear();
      mailbox.assertNotSent();
    });
  });

  describe('development transports', () => {
    it('FileMailTransport writes .eml files that parse', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mail-files-'));
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
      try {
        await compile([MailModule.forRoot({ transport: new FileMailTransport({ directory: join(dir, 'mail') }), from: FROM })]);
        const result = await moduleRef!.get(Mailer).send({ to: 'a@example.com', subject: 'Zamówienie', html: '<p>Hi</p>' });

        const [file] = readdirSync(join(dir, 'mail'));
        expect(file).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f-]+\.eml$/);

        const parsed = parseMessage(readFileSync(join(dir, 'mail', file), 'utf8'));
        expect(parsed.headers.find(([n]) => n === 'Message-ID')?.[1]).toBe(result.messageId);
        expect(log).toHaveBeenCalledWith(expect.stringContaining(`"Zamówienie" to a@example.com written to ${join(dir, 'mail', file)}`));
      } finally {
        log.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('LogMailTransport logs recipients and subject, and the text at debug level', async () => {
      const lines: [string, string][] = [];
      const logger: LoggerService = {
        log: (m) => lines.push(['log', m]),
        debug: (m) => lines.push(['debug', m]),
        error: () => {},
        warn: () => {},
      };

      await compile([MailModule.forRoot({ transport: new LogMailTransport({ logger }), from: FROM })]);
      await moduleRef!.get(Mailer).send({
        to: 'a@example.com',
        subject: 'Sign in',
        html: '<a href="https://shop.example.com/magic?token=abc">Sign in</a>',
        attachments: [{ filename: 'a.txt', content: 'x' }],
      });

      expect(lines).toEqual([
        ['log', '"Sign in" to a@example.com with 1 attachment(s): a.txt'],
        ['debug', 'Sign in (https://shop.example.com/magic?token=abc)'],
      ]);
    });
  });
});
