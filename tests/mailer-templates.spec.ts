import { Inject, Injectable, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  FileTemplateEngine,
  html,
  InMemoryMailTransport,
  type Mailable,
  Mailer,
  MailMessageError,
  MailModule,
  type MailRenderContext,
  MailTemplateEngine,
  MailTemplateError,
  type MailTemplateOutput,
  type MailTemplateRenderOptions,
} from '../lib/index.js';

/** The error `promise` rejects with; fails the test when it resolves. */
function rejection(promise: Promise<unknown>): Promise<MailTemplateError> {
  return promise.then(
    () => {
      throw new Error('Expected a rejection');
    },
    (error: unknown) => error as MailTemplateError,
  );
}


const FROM = 'Orders <orders@example.com>';
const dir = mkdtempSync(join(tmpdir(), 'nestjs-mail-templates-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

write({
  'layout.html': '<main>{{{ body }}}</main>',
  'order-confirmation.html': [
    '<p>Hi {{ customer }},</p>',
    '<ul>{{#each items}}<li>{{ name }}: {{ price }}</li>{{/each}}</ul>',
    '<p><a href="{{ orderUrl }}">View your order</a></p>',
  ].join('\n'),
  'order-confirmation.pl.html': '<p>Cześć {{ customer }},</p><p><a href="{{ orderUrl }}">Zobacz zamówienie</a></p>',
  'order-confirmation.txt': 'Hi {{ customer }},\n{{#each items}}\n- {{ name }}: {{ price }}\n{{/each}}\n{{ orderUrl }}\n',
  'welcome.html': '<p>Welcome, {{ name }}</p>',
});

interface Order {
  number: number;
  customer: string;
  items: { name: string; price: number }[];
}

/** Prepares the view model: formatted prices and the link, in the mail class. */
@Injectable()
class OrderConfirmationMail implements Mailable<Order> {
  render(order: Order, { locale }: MailRenderContext) {
    const price = (cents: number) => `$${(cents / 100).toFixed(2)}`;
    return {
      subject: locale === 'pl' ? `Zamówienie #${order.number}` : `Order #${order.number}`,
      template: 'order-confirmation',
      context: {
        customer: order.customer,
        items: order.items.map((item) => ({ name: item.name, price: price(item.price) })),
        orderUrl: `https://shop.example.com/orders/${order.number}?ref=mail&lang=${locale ?? 'en'}`,
      },
    };
  }
}

const order: Order = {
  number: 1001,
  customer: 'Ada <Lovelace>',
  items: [
    { name: 'Salmon kibble', price: 2499 },
    { name: 'Feather wand <limited>', price: 799 },
  ],
};

describe('Mailer: templates', () => {
  let moduleRef: TestingModule;
  let mailer: Mailer;
  const mailbox = new InMemoryMailTransport();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({
          transport: mailbox,
          templates: new FileTemplateEngine({ dir, layout: 'layout' }),
          from: FROM,
        }),
      ],
      providers: [OrderConfirmationMail],
    }).compile();
    mailer = moduleRef.get(Mailer);
  });
  afterAll(() => moduleRef.close());
  beforeEach(() => mailbox.clear());

  it('sends a mail class that returns a template and its context', async () => {
    await mailer.send(OrderConfirmationMail, { to: 'ada@example.com', data: order });

    const mail = mailbox.assertSent({ template: 'order-confirmation', mail: OrderConfirmationMail });
    expect(mail.template).toBe('order-confirmation');
    expect(mail.subject).toBe('Order #1001');
    expect(mail.html).toBe(
      '<main><p>Hi Ada &lt;Lovelace&gt;,</p>\n' +
        '<ul><li>Salmon kibble: $24.99</li><li>Feather wand &lt;limited&gt;: $7.99</li></ul>\n' +
        '<p><a href="https://shop.example.com/orders/1001?ref=mail&amp;lang=en">View your order</a></p></main>',
    );
    // The .txt template, not text derived from the HTML
    expect(mail.text).toBe(
      'Hi Ada <Lovelace>,\n- Salmon kibble: $24.99\n- Feather wand <limited>: $7.99\nhttps://shop.example.com/orders/1001?ref=mail&lang=en\n',
    );
    expect(mail.link('/orders/').searchParams.get('lang')).toBe('en');
  });

  it("renders the template in the mail's locale, and derives the text when there is no .txt for it", async () => {
    await mailer.send(OrderConfirmationMail, { to: 'zofia@example.com', data: order, locale: 'pl' });

    const mail = mailbox.assertSent({ to: 'zofia@example.com' });
    expect(mail.locale).toBe('pl');
    expect(mail.html).toBe(
      '<main><p>Cześć Ada &lt;Lovelace&gt;,</p><p><a href="https://shop.example.com/orders/1001?ref=mail&amp;lang=pl">Zobacz zamówienie</a></p></main>',
    );
    // order-confirmation.txt is the fallback for every locale
    expect(mail.text).toContain('- Salmon kibble: $24.99');
  });

  it('sends a message written inline with a template, in its locale', async () => {
    await mailer.send({ to: 'ada@example.com', subject: 'Welcome', template: 'welcome', context: { name: 'Ada & co' }, locale: 'pl' });

    const mail = mailbox.assertSent({ template: 'welcome' });
    expect(mail.html).toBe('<main><p>Welcome, Ada &amp; co</p></main>');
    expect(mail.text).toBe('Welcome, Ada & co');
    expect(mail.locale).toBe('pl');
    expect(mail.mail).toBeUndefined();
  });

  it('previews templates without sending: a mail class, and a message written inline without recipients', async () => {
    const fromClass = await mailer.render(OrderConfirmationMail, { data: order, locale: 'pl' });
    expect(fromClass.html).toContain('Zobacz zamówienie');
    expect(fromClass.template).toBe('order-confirmation');

    const inline = await mailer.render({ subject: 'Welcome', template: 'welcome', context: { name: 'Ada' } });
    expect(inline.html).toBe('<main><p>Welcome, Ada</p></main>');
    expect(inline.to).toEqual([]);
    mailbox.assertNotSent();
  });

  it('still sends HTML written inline, and previews it', async () => {
    await mailer.send({ to: 'ada@example.com', subject: 'Hi', html: html`<p>${'<Ada>'}</p>` });
    expect(mailbox.assertSent({ subject: 'Hi' }).template).toBeUndefined();

    const preview = await mailer.render({ subject: 'Hi', text: 'plain' });
    expect(preview.text).toBe('plain');
  });

  it('lists the template of each mail when an assertion fails', async () => {
    await mailer.send({ to: 'ada@example.com', subject: 'Welcome', template: 'welcome' });
    expect(() => mailbox.assertSent({ template: 'order-confirmation' })).toThrow(
      'Expected a mail from the template order-confirmation, but none was sent. Sent:\n  - "Welcome" to ada@example.com [welcome]',
    );
  });

  it('refuses a template together with html or text, and context without a template', async () => {
    const send = (message: object) => mailer.send({ to: 'ada@example.com', subject: 'x', ...message } as never);
    await expect(send({ template: 'welcome', html: '<p>x</p>' })).rejects.toThrow(
      new MailMessageError('template', 'and `html` are both set: the template renders the body (a .txt template the text)'),
    );
    await expect(send({ template: 'welcome', text: 'x' })).rejects.toThrow('Invalid mail: template and `text` are both set');
    await expect(send({ html: '<p>x</p>', context: {} })).rejects.toThrow('Invalid mail: context is only used with `template`');
    await expect(send({ template: '' })).rejects.toThrow('Invalid mail: template must be a non-empty string');
    await expect(send({ template: 'welcome', context: 'Ada' })).rejects.toThrow('Invalid mail: context must be an object');
    mailbox.assertNotSent();
  });

  it('fails a missing template permanently, before sending', async () => {
    const error = await rejection(mailer.send({ to: 'ada@example.com', subject: 'x', template: 'nope' }));
    expect(error).toBeInstanceOf(MailTemplateError);
    expect(error).toMatchObject({ template: 'nope', permanent: true });
    mailbox.assertNotSent();
  });

  it('provides the engine for injection', () => {
    expect(moduleRef.get(MailTemplateEngine)).toBeInstanceOf(FileTemplateEngine);
  });

  it('types a template and its context apart from html and text', () => {
    // @ts-expect-error html and template are exclusive
    void (() => mailer.send({ to: 'a@example.com', subject: 'x', html: 'x', template: 'welcome' }));
    // @ts-expect-error context goes with a template only
    void (() => mailer.send({ to: 'a@example.com', subject: 'x', html: 'x', context: {} }));
    // @ts-expect-error text comes from the template
    void (() => mailer.render({ subject: 'x', text: 'x', template: 'welcome' }));
  });
});

describe('Mailer: without a template engine', () => {
  it('names the missing option when a mail asks for a template', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MailModule.forRoot({ transport: new InMemoryMailTransport(), from: FROM })],
    }).compile();

    expect(moduleRef.get(MailTemplateEngine)).toBeNull();
    const error = await rejection(moduleRef
      .get(Mailer)
      .render({ subject: 'x', template: 'welcome' })
      );
    expect(error).toBeInstanceOf(MailTemplateError);
    expect(error.message).toBe(
      'The mail names the template "welcome", but MailModule has no template engine: pass ' +
        "`templates: new FileTemplateEngine({ dir: 'templates' })`, or your own MailTemplateEngine, to forRoot()",
    );
    await moduleRef.close();
  });
});

describe('Mailer: custom template engines', () => {
  const SHOP = Symbol('SHOP');

  @Module({ providers: [{ provide: SHOP, useValue: { name: 'Cats' } }], exports: [SHOP] })
  class ShopModule {}

  /** A class Nest instantiates, so it injects what it needs. */
  @Injectable()
  class BrandedEngine extends MailTemplateEngine {
    constructor(@Inject(SHOP) private readonly shop: { name: string }) {
      super();
    }

    async render(name: string, context: object, { locale }: MailTemplateRenderOptions): Promise<MailTemplateOutput> {
      return { html: `<p>${this.shop.name}: ${name} ${JSON.stringify(context)} ${locale}</p>`, text: `${this.shop.name} text` };
    }
  }

  it('takes an engine class at the top level, instantiated with the providers of `imports`', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({ transport: new InMemoryMailTransport(), templates: BrandedEngine, imports: [ShopModule], from: FROM }),
      ],
    }).compile();

    const message = await moduleRef.get(Mailer).render({ subject: 'x', template: 'hello', context: { a: 1 }, locale: 'pl' });
    expect(message.html).toBe('<p>Cats: hello {"a":1} pl</p>');
    expect(message.text).toBe('Cats text');
    await moduleRef.close();
  });

  it('takes an engine instance from the async factory', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MailModule.forRootAsync({
          useFactory: () => ({ transport: new InMemoryMailTransport(), templates: new FileTemplateEngine({ dir }), from: FROM }),
        }),
      ],
    }).compile();

    const message = await moduleRef.get(Mailer).render({ subject: 'x', template: 'welcome', context: { name: 'Ada' } });
    expect(message.html).toBe('<p>Welcome, Ada</p>');
    await moduleRef.close();
  });

  it('refuses a class from the async factory, an engine in two places, and a value that is no engine', async () => {
    const compile = (imports: never[]) => Test.createTestingModule({ imports }).compile();
    const transport = new InMemoryMailTransport();

    await expect(
      compile([MailModule.forRootAsync({ useFactory: () => ({ transport, templates: BrandedEngine as never }) }) as never]),
    ).rejects.toThrow('the forRootAsync() factory returned a class as `templates` (BrandedEngine)');
    await expect(
      compile([
        MailModule.forRootAsync({
          templates: new FileTemplateEngine({ dir }),
          useFactory: () => ({ transport, templates: new FileTemplateEngine({ dir }) }),
        }) as never,
      ]),
    ).rejects.toThrow('`templates` is set both at the top level of forRootAsync() and in the options its factory returns');
    expect(() => MailModule.forRoot({ transport, templates: { render: 'no' } as never })).toThrow(
      'MailModule: `templates` from forRoot() must be a MailTemplateEngine class or instance',
    );
    await expect(
      compile([MailModule.forRootAsync({ useFactory: () => ({ transport, templates: {} as never }) }) as never]),
    ).rejects.toThrow('MailModule: `templates` from the forRootAsync() factory must be a MailTemplateEngine class or instance');
  });

  it('refuses output that is not HTML', async () => {
    class BrokenEngine extends MailTemplateEngine {
      render() {
        return { text: 'no html' } as never;
      }
    }
    const moduleRef = await Test.createTestingModule({
      imports: [MailModule.forRoot({ transport: new InMemoryMailTransport(), templates: new BrokenEngine(), from: FROM })],
    }).compile();

    await expect(moduleRef.get(Mailer).render({ subject: 'x', template: 'a' })).rejects.toThrow(
      'BrokenEngine.render() must return the HTML as a string, or { html, text? }',
    );
    await moduleRef.close();
  });

  /**
   * The shape of a Handlebars engine, on a fake with Handlebars' API (`compile()` returning
   * a function of the context), so the package needs no handlebars dependency.
   */
  const fakeHandlebars = {
    compile(source: string, options: { compat: boolean }) {
      expect(options.compat).toBe(true);
      return (context: Record<string, unknown>) =>
        source.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) =>
          String(context[key] ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
        );
    },
  };

  class HandlebarsTemplateEngine extends MailTemplateEngine {
    private readonly templates = new Map<string, (context: object) => string>();

    constructor(private readonly templatesDir: string) {
      super();
    }

    render(name: string, context: object, { locale }: MailTemplateRenderOptions) {
      const file = join(this.templatesDir, `${name}${locale ? `.${locale}` : ''}.hbs`);
      let template = this.templates.get(file);
      if (!template) {
        template = fakeHandlebars.compile(readFileSync(file, 'utf8'), { compat: true }) as (context: object) => string;
        this.templates.set(file, template);
      }
      return template(context);
    }
  }

  it('plugs in a Handlebars-style engine that returns the HTML as a string', async () => {
    write({ 'hbs/receipt.hbs': '<p>Thanks, {{ name }}</p>', 'hbs/receipt.pl.hbs': '<p>Dzięki, {{ name }}</p>' });
    const mailbox = new InMemoryMailTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        MailModule.forRoot({ transport: mailbox, templates: new HandlebarsTemplateEngine(join(dir, 'hbs')), from: FROM }),
      ],
    }).compile();

    await moduleRef.get(Mailer).send({ to: 'ada@example.com', subject: 'Receipt', template: 'receipt', context: { name: '<Ada>' } });
    await moduleRef.get(Mailer).send({ to: 'zofia@example.com', subject: 'Paragon', template: 'receipt', context: { name: 'Zofia' }, locale: 'pl' });

    const [en, pl] = mailbox.filter({ template: 'receipt' });
    expect(en.html).toBe('<p>Thanks, &#60;Ada&#62;</p>');
    expect(en.text).toBe('Thanks, <Ada>'); // derived from the HTML
    expect(pl.html).toBe('<p>Dzięki, Zofia</p>');
    await moduleRef.close();
  });
});
