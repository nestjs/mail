import { Injectable, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { firstValueFrom, toArray } from 'rxjs';
import {
  InMemoryMailTransport,
  type Mailable,
  Mailer,
  type MailEvent,
  MailEvents,
  type MailMessage,
  MailModule,
  type MailModuleOptions,
  MailProviderError,
  type MailRenderContext,
  MailTransport,
  type MailTransportSendOptions,
} from '../lib/index.js';

const FROM = 'Orders <orders@example.com>';
const mail = { to: 'ada@example.com', subject: 'Hi', text: 'Hello' };

/** Records the calls, fails as scripted, and returns what it is told to. */
class ScriptedTransport extends MailTransport {
  readonly calls: { message: MailMessage; options: MailTransportSendOptions }[] = [];
  constructor(
    private readonly failures: unknown[] = [],
    private readonly result: object = {},
  ) {
    super();
  }
  async send(message: MailMessage, options: MailTransportSendOptions) {
    this.calls.push({ message, options });
    const failure = this.failures.shift();
    if (failure) {
      throw failure;
    }
    return this.result;
  }
}

describe('Mailer', () => {
  let moduleRef: TestingModule | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    await moduleRef?.close();
    moduleRef = undefined;
  });

  async function setup(transport: MailTransport, options: Omit<MailModuleOptions, 'transport'> = {}) {
    moduleRef = await Test.createTestingModule({ imports: [MailModule.forRoot({ transport, from: FROM, ...options })] }).compile();
    await moduleRef.init();
    const events: MailEvent[] = [];
    moduleRef.get(MailEvents).events$.subscribe((event) => events.push(event));
    return { mailer: moduleRef.get(Mailer), events };
  }

  describe('results and events', () => {
    it('reports what the transport accepted and its reply, and leaves out what it did not give', async () => {
      const { mailer, events } = await setup(new ScriptedTransport([], { accepted: ['ada@example.com'], response: '250 queued' }));
      const result = await mailer.send({ ...mail, cc: 'refused@example.com' });

      expect(result).toEqual({ messageId: expect.any(String), accepted: ['ada@example.com'], attempts: 1, response: '250 queued' });
      expect(events[0]).not.toHaveProperty('providerMessageId');
      expect(events[0]).not.toHaveProperty('mail');
    });

    it('defaults accepted to every envelope recipient when the transport returns nothing', async () => {
      class Silent extends MailTransport {
        async send() {
          return undefined as never;
        }
      }
      const { mailer } = await setup(new Silent());
      const result = await mailer.send({ ...mail, cc: 'c@example.com', bcc: 'b@example.com' });

      expect(result).toEqual({ messageId: expect.any(String), accepted: ['ada@example.com', 'c@example.com', 'b@example.com'], attempts: 1 });
    });

    it('names the mail class and the transport in events', async () => {
      class ReceiptMail implements Mailable {
        render() {
          return { subject: 'Receipt', text: 'Paid' };
        }
      }
      const { mailer, events } = await setup(new ScriptedTransport());
      await mailer.send(ReceiptMail, { to: 'ada@example.com' });

      expect(events).toEqual([expect.objectContaining({ type: 'sent', mail: 'ReceiptMail', transport: 'ScriptedTransport', subject: 'Receipt' })]);
    });
  });

  describe('retries', () => {
    it('waits the configured backoff between attempts', async () => {
      vi.useFakeTimers();
      const transport = new ScriptedTransport([new Error('reset'), new Error('reset')]);
      const { mailer } = await setup(transport, { retry: { attempts: 3, backoff: { delay: '1s', factor: 2, jitter: 'none' } } });

      const sending = mailer.send(mail);
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(transport.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.calls).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(transport.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(sending).resolves.toMatchObject({ attempts: 3 });
    });

    it("waits at least a provider's Retry-After before the next attempt", async () => {
      vi.useFakeTimers();
      const throttled = new MailProviderError({ provider: 'resend', status: 429, retryAfterMs: 5_000 });
      const transport = new ScriptedTransport([throttled]);
      const { mailer } = await setup(transport, { retry: { attempts: 2, backoff: { delay: '1s', jitter: 'none' } } });

      const sending = mailer.send(mail);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(transport.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(sending).resolves.toMatchObject({ attempts: 2 });
    });

    it('caps the Retry-After wait at maxDelay', async () => {
      vi.useFakeTimers();
      const throttled = new MailProviderError({ provider: 'sendgrid', status: 503, retryAfterMs: 3_600_000 });
      const transport = new ScriptedTransport([throttled]);
      const { mailer } = await setup(transport, { retry: { attempts: 2, backoff: { delay: '1s', maxDelay: '10s', jitter: 'none' } } });

      const sending = mailer.send(mail);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(transport.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(sending).resolves.toMatchObject({ attempts: 2 });
    });

    it('stops a Retry-After wait when the signal aborts', async () => {
      vi.useFakeTimers();
      const throttled = new MailProviderError({ provider: 'postmark', status: 429, retryAfterMs: 20_000 });
      const transport = new ScriptedTransport([throttled]);
      const { mailer, events } = await setup(transport, { retry: { attempts: 2, backoff: { delay: 0 } } });
      const controller = new AbortController();
      const reason = new Error('shutting down');

      const sending = mailer.send({ ...mail, signal: controller.signal });
      const outcome = sending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort(reason);

      expect(await outcome).toBe(reason);
      expect(transport.calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(events).toEqual([expect.objectContaining({ type: 'failed', attempts: 1, error: reason })]);
    });

    it('retries errors a custom transport throws unless they say permanent or carry a 4xx status', async () => {
      const permanent = Object.assign(new Error('bounced'), { permanent: true });
      const unavailable = Object.assign(new Error('unavailable'), { status: 503 });
      const transport = new ScriptedTransport([unavailable, permanent]);
      const { mailer, events } = await setup(transport, { retry: { attempts: 5, backoff: { delay: 0 } } });

      await expect(mailer.send(mail)).rejects.toBe(permanent);
      expect(transport.calls).toHaveLength(2);
      expect(events).toEqual([expect.objectContaining({ type: 'failed', attempts: 2, permanent: true })]);
    });

    it('takes a number as the attempts, per send', async () => {
      const transport = new ScriptedTransport([new Error('1'), new Error('2'), new Error('3')]);
      const { mailer } = await setup(transport, { retry: false });

      await expect(mailer.send({ ...mail, retry: 2 })).rejects.toThrow('2');
      expect(transport.calls).toHaveLength(2);
    });

    it('does not ask retryIf about a permanent error, and passes it the attempt', async () => {
      const retryIf = vi.fn(() => true);
      const transport = new ScriptedTransport([new Error('transient'), Object.assign(new Error('permanent'), { permanent: true })]);
      const { mailer } = await setup(transport, { retry: { attempts: 5, backoff: { delay: 0 }, retryIf } });

      await expect(mailer.send(mail)).rejects.toThrow('permanent');
      expect(retryIf.mock.calls).toEqual([[expect.objectContaining({ message: 'transient' }), 1]]);
    });

    it('does not start a send whose signal has already aborted, and reports it as failed after 0 attempts', async () => {
      const transport = new ScriptedTransport();
      const { mailer, events } = await setup(transport);
      const reason = new Error('gone');

      await expect(mailer.send({ ...mail, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
      expect(transport.calls).toEqual([]);
      expect(events).toEqual([expect.objectContaining({ type: 'failed', attempts: 0, error: reason })]);
    });

    it('hands the transport the signal and the idempotency key', async () => {
      const transport = new ScriptedTransport();
      const { mailer } = await setup(transport);
      const controller = new AbortController();

      await mailer.send({ ...mail, signal: controller.signal, idempotencyKey: 'k1' });
      await mailer.send(mail);

      expect(transport.calls[0].options).toEqual({ signal: controller.signal, attempt: 1, idempotencyKey: 'k1' });
      expect(transport.calls[1].options).not.toHaveProperty('idempotencyKey');
      expect(transport.calls[1].options.signal.aborted).toBe(false);
    });
  });

  describe('module defaults', () => {
    it('adds the default replyTo and headers, which a message can override', async () => {
      const mailbox = new InMemoryMailTransport();
      const { mailer } = await setup(mailbox, { replyTo: 'help@example.com', headers: { 'X-App': 'shop', 'X-Env': 'test' } });

      await mailer.send({ ...mail, headers: { 'X-Env': 'override' } });
      await mailer.send({ ...mail, replyTo: 'billing@example.com' });

      const [first, second] = mailbox.mails;
      expect(first.message.replyTo).toEqual([{ address: 'help@example.com' }]);
      expect(first.headers).toEqual({ 'X-App': 'shop', 'X-Env': 'override' });
      expect(second.message.replyTo).toEqual([{ address: 'billing@example.com' }]);
    });

    it('fails on a send without a from when the module has none', async () => {
      const { mailer } = await setup(new InMemoryMailTransport(), { from: undefined });
      await expect(mailer.send(mail)).rejects.toThrow(/Invalid mail: from is missing/);
      await expect(mailer.send({ ...mail, from: 'me@example.com' })).resolves.toMatchObject({ attempts: 1 });
    });
  });

  describe('mail classes', () => {
    it('gives render() the data, the locale and the parsed recipients', async () => {
      const seen: unknown[] = [];
      class ContextMail implements Mailable<{ n: number }> {
        render(data: { n: number }, context: MailRenderContext) {
          seen.push([data, context]);
          return { subject: `#${data.n}`, text: 'x' };
        }
      }
      const { mailer } = await setup(new InMemoryMailTransport());
      await mailer.send(ContextMail, { to: ['Ada <ADA@Example.com>', 'b@example.com'], data: { n: 1 }, locale: 'de' });
      await mailer.render(ContextMail, { data: { n: 2 } });

      expect(seen).toEqual([
        [{ n: 1 }, { locale: 'de', to: [{ name: 'Ada', address: 'ADA@example.com' }, { address: 'b@example.com' }] }],
        [{ n: 2 }, { locale: undefined, to: [] }],
      ]);
    });

    it("uses render()'s from and replyTo unless send() overrides them", async () => {
      class SupportMail implements Mailable {
        render() {
          return { subject: 's', text: 't', from: 'support@example.com', replyTo: 'tickets@example.com' };
        }
      }
      const mailbox = new InMemoryMailTransport();
      const { mailer } = await setup(mailbox);

      await mailer.send(SupportMail, { to: 'a@example.com' });
      await mailer.send(SupportMail, { to: 'a@example.com', from: 'ceo@example.com', replyTo: 'ceo@example.com' });

      expect(mailbox.mails.map((m) => [m.from.address, m.message.replyTo[0].address])).toEqual([
        ['support@example.com', 'tickets@example.com'],
        ['ceo@example.com', 'ceo@example.com'],
      ]);
    });

    it('awaits an async render(), and returns the message from render() with the class and locale', async () => {
      class AsyncMail implements Mailable {
        async render() {
          await Promise.resolve();
          return { subject: 'Async', html: '<p>Later</p>' };
        }
      }
      const { mailer } = await setup(new InMemoryMailTransport());
      const preview = await mailer.render(AsyncMail, { locale: 'fr' });

      expect(preview).toMatchObject({ subject: 'Async', text: 'Later', mail: AsyncMail, locale: 'fr' });
      expect(preview.from.address).toBe('orders@example.com');
    });

    it('creates a mail class that is not a provider once, and reuses it', async () => {
      let created = 0;
      @Injectable()
      class CountedMail implements Mailable {
        constructor() {
          created++;
        }
        render() {
          return { subject: 's', text: 't' };
        }
      }
      const { mailer } = await setup(new InMemoryMailTransport());
      await Promise.all([mailer.send(CountedMail, { to: 'a@example.com' }), mailer.send(CountedMail, { to: 'b@example.com' })]);
      await mailer.render(CountedMail, {});

      expect(created).toBe(1);
    });

    it('reports a mail class it cannot create, and tries again on the next send', async () => {
      let attempts = 0;
      @Injectable()
      class FlakyMail implements Mailable {
        constructor() {
          if (++attempts === 1) {
            throw new Error('configuration not loaded yet');
          }
        }
        render() {
          return { subject: 's', text: 't' };
        }
      }
      const { mailer } = await setup(new InMemoryMailTransport());

      await expect(mailer.send(FlakyMail, { to: 'a@example.com' })).rejects.toThrow('configuration not loaded yet');
      await expect(mailer.send(FlakyMail, { to: 'a@example.com' })).resolves.toMatchObject({ attempts: 1 });
      expect(attempts).toBe(2);
    });
  });

  describe('registration', () => {
    it('isGlobal: false keeps the Mailer inside the importing module', async () => {
      @Injectable()
      class Consumer {
        constructor(readonly mailer: Mailer) {}
      }
      @Module({ providers: [Consumer] })
      class Outside {}

      await expect(
        Test.createTestingModule({
          imports: [MailModule.forRoot({ transport: new InMemoryMailTransport(), from: FROM, isGlobal: false }), Outside],
        }).compile(),
      ).rejects.toThrow(/Mailer/);
    });

    it('forRoot() refuses a transport that is not a MailTransport', () => {
      expect(() => MailModule.forRoot({ transport: { deliver() {} } as never })).toThrow(
        'MailModule: `transport` from forRoot() must be a MailTransport class or instance',
      );
    });

    it('forRoot() instantiates a transport class with DI', async () => {
      const { mailer } = await setup(InMemoryMailTransport as never);
      await mailer.send(mail);
      expect((moduleRef!.get(MailTransport) as InMemoryMailTransport).mails).toHaveLength(1);
    });

    it('forRootAsync(): the same instance at the top level and from the factory is fine', async () => {
      const mailbox = new InMemoryMailTransport();
      moduleRef = await Test.createTestingModule({
        imports: [MailModule.forRootAsync({ transport: mailbox, useFactory: () => ({ transport: mailbox, from: FROM }) })],
      }).compile();
      await moduleRef.init();

      expect(moduleRef.get(MailTransport)).toBe(mailbox);
    });

    it('forRootAsync(): a factory that returns something else than a transport fails at startup', async () => {
      await expect(
        Test.createTestingModule({ imports: [MailModule.forRootAsync({ useFactory: () => ({ transport: 'smtp://x' as never }) })] }).compile(),
      ).rejects.toThrow('MailModule: `transport` from the forRootAsync() factory must be a MailTransport class or instance');
    });

    it('forRootAsync(): invalid defaults from the factory fail at startup', async () => {
      await expect(
        Test.createTestingModule({
          imports: [MailModule.forRootAsync({ useFactory: () => ({ transport: new InMemoryMailTransport(), from: 'a@b@c' }) })],
        }).compile(),
      ).rejects.toThrow(/MailModule: Invalid mail: from/);
    });
  });

  describe('shutdown', () => {
    it('completes events$ and closes the transport even with nothing in flight', async () => {
      const close = vi.fn();
      class Closing extends ScriptedTransport {
        close() {
          close();
        }
      }
      await setup(new Closing());
      const completed = firstValueFrom(moduleRef!.get(MailEvents).events$.pipe(toArray()));

      await moduleRef!.close();
      moduleRef = undefined;

      await expect(completed).resolves.toEqual([]);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('closes a transport without close() without failing', async () => {
      await setup(new ScriptedTransport());
      await expect(moduleRef!.close()).resolves.toBeUndefined();
      moduleRef = undefined;
    });
  });
});
