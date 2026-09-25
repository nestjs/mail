import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { FileTemplateEngine, html, MailError, MailTemplateError, type FileTemplateEngineOptions } from '../lib/index.js';

/** The error `promise` rejects with; fails the test when it resolves. */
function rejection(promise: Promise<unknown>): Promise<MailTemplateError> {
  return promise.then(
    () => {
      throw new Error('Expected a rejection');
    },
    (error: unknown) => error as MailTemplateError,
  );
}


/** A temporary templates directory with `files` in it, and an engine over it. */
function setup(files: Record<string, string>, options: Omit<FileTemplateEngineOptions, 'dir'> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nestjs-mail-templates-'));
  const write = (name: string, content: string) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  };
  for (const [name, content] of Object.entries(files)) {
    write(name, content);
  }

  dirs.push(dir);
  return { dir, write, engine: new FileTemplateEngine({ dir, ...options }) };
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Renders `source` as `t.html` (or `t.txt` alongside) with `context`. */
async function render(source: string, context: object = {}, locale?: string) {
  const { engine } = setup({ 't.html': source });
  return (await engine.render('t', context, { locale })).html;
}

/** The error rendering `source` throws. */
async function failure(source: string, context: object = {}): Promise<MailTemplateError> {
  const error = await rejection(render(source, context));
  expect(error).toBeInstanceOf(MailTemplateError);
  return error;
}

describe('FileTemplateEngine: values', () => {
  it('inserts values by path, with or without spaces inside the braces', async () => {
    const out = await render('<p>{{ customer.name }} #{{order.number}} {{ this.shop }} {{ ./shop }}</p>', {
      customer: { name: 'Ada' },
      order: { number: 1001 },
      shop: 'Cats',
    });
    expect(out).toBe('<p>Ada #1001 Cats Cats</p>');
  });

  it('escapes all five HTML characters in {{ }}', async () => {
    expect(await render('<p title="{{ v }}">{{ v }}</p>', { v: `<a href='x'>"&"</a>` })).toBe(
      '<p title="&lt;a href=&#39;x&#39;&gt;&quot;&amp;&quot;&lt;/a&gt;">&lt;a href=&#39;x&#39;&gt;&quot;&amp;&quot;&lt;/a&gt;</p>',
    );
  });

  it('inserts {{{ }}} unescaped, and SafeHtml from the html tag as it is in either form', async () => {
    const context = { raw: '<b>bold</b>', safe: html`<i>${'<x>'}</i>` };
    expect(await render('{{{ raw }}} {{ safe }} {{{safe}}}', context)).toBe('<b>bold</b> <i>&lt;x&gt;</i> <i>&lt;x&gt;</i>');
  });

  it('renders missing and null values as nothing, and 0 and false as text', async () => {
    const out = await render('[{{ missing }}][{{ a.b.c }}][{{ empty }}][{{ zero }}][{{ no }}][{{ list }}]', {
      empty: null,
      zero: 0,
      no: false,
      list: ['a', 'b'],
    });
    expect(out).toBe('[][][][0][false][a,b]');
  });

  it("reads own properties only: nothing from a prototype, and functions aren't called", async () => {
    class ViewModel {
      own = 'own';
      get inherited() {
        return 'inherited';
      }
    }
    const out = await render(
      '[{{ constructor }}][{{ items.constructor.name }}][{{ __proto__ }}][{{ model.inherited }}][{{ model.own }}][{{ fn }}][{{ items.length }}]',
      { items: [1, 2], model: new ViewModel(), fn: () => 'called' },
    );
    expect(out).toBe('[][][][][own][][2]');
  });

  it('reads array items by index', async () => {
    expect(await render('{{ items.1.name }}/{{ items/0/name }}', { items: [{ name: 'a' }, { name: 'b' }] })).toBe('b/a');
  });

  it('reports a value that has no text form, at its position', async () => {
    const error = await failure('<p>\n  {{ weird }}</p>', { weird: Object.create(null) });
    expect(error.message).toBe("t.html:2:3: {{ weird }} can't be converted to text");
    expect(error.cause).toBeInstanceOf(TypeError);
  });
});

describe('FileTemplateEngine: blocks', () => {
  it('renders #if and its else by Handlebars truthiness', async () => {
    const template = '{{#if v}}yes{{else}}no{{/if}}';
    const cases: [unknown, string][] = [
      [true, 'yes'],
      ['x', 'yes'],
      [1, 'yes'],
      [{}, 'yes'],
      [[0], 'yes'],
      [false, 'no'],
      [0, 'no'],
      ['', 'no'],
      [null, 'no'],
      [undefined, 'no'],
      [[], 'no'],
    ];
    for (const [v, expected] of cases) {
      expect(await render(template, { v }), String(v)).toBe(expected);
    }
  });

  it('renders #unless and its else', async () => {
    expect(await render('{{#unless paid}}due{{else}}paid{{/unless}}', { paid: false })).toBe('due');
    expect(await render('{{#unless paid}}due{{else}}paid{{/unless}}', { paid: true })).toBe('paid');
    expect(await render('{{#unless paid}}due{{/unless}}', { paid: true })).toBe('');
  });

  it('chains {{else if}} and {{else unless}}, closed by the first block', async () => {
    const template = '{{#if a}}A{{else if b}}B{{else unless c}}not C{{else}}C{{/if}}';
    expect(await render(template, { a: 1 })).toBe('A');
    expect(await render(template, { b: 1 })).toBe('B');
    expect(await render(template, {})).toBe('not C');
    expect(await render(template, { c: 1 })).toBe('C');
  });

  it('iterates #each with this, @index, @first and @last', async () => {
    const out = await render(
      '{{#each items}}[{{@index}}:{{ this }}{{#if @first}} first{{/if}}{{#if @last}} last{{/if}}]{{/each}}',
      { items: ['a', 'b', 'c'] },
    );
    expect(out).toBe('[0:a first][1:b][2:c last]');
  });

  it("renders #each's else for an empty list, a missing one and a non-list", async () => {
    const template = '{{#each items}}{{ this }}{{else}}none{{/each}}';
    expect(await render(template, { items: [] })).toBe('none');
    expect(await render(template, {})).toBe('none');
    expect(await render(template, { items: 42 })).toBe('none');
  });

  it('iterates the values of an object with @key, and of any iterable', async () => {
    expect(await render('{{#each prices}}{{@key}}={{ this }};{{/each}}', { prices: { usd: 5, eur: 4 } })).toBe('usd=5;eur=4;');
    expect(await render('{{#each tags}}{{ this }}{{#unless @last}},{{/unless}}{{/each}}', { tags: new Set(['a', 'b']) })).toBe(
      'a,b',
    );
  });

  it('looks up plain paths in outer contexts, and this, ./ and ../ in one context only', async () => {
    const context = {
      currency: 'USD',
      name: 'root',
      orders: [{ number: 1, items: [{ name: 'Kibble', price: 5 }, { name: 'Wand', price: 2, currency: 'EUR' }] }],
    };
    const out = await render(
      '{{#each orders}}{{#each items}}{{ name }} {{ price }} {{ currency }} #{{ number }} #{{ ../number }} [{{ this.currency }}] [{{ ../../name }}] [{{ @root.name }}];{{/each}}{{/each}}',
      context,
    );
    expect(out).toBe('Kibble 5 USD #1 #1 [] [root] [root];Wand 2 EUR #1 #1 [EUR] [root] [root];');
  });

  it("keeps @index to the innermost #each, and reads the parent item with ../ (not the parent's @index)", async () => {
    expect((await failure('{{#each rows}}{{#each this}}{{ @../index }}{{/each}}{{/each}}')).message).toBe(
      't.html:1:29: unknown data variable @../index: there are @index, @first, @last, @key and @root',
    );
    expect(await render('{{#each rows}}{{#each cells}}{{@index}}{{ ../label }}{{/each}}|{{/each}}', {
      rows: [
        { label: 'a', cells: [1, 2] },
        { label: 'b', cells: [3] },
      ],
    })).toBe('0a1a|0b|');
  });

  it('skips comments, including ones that contain }}', async () => {
    expect(await render('a{{! a comment }}b{{!-- {{ not a value }} --}}c')).toBe('abc');
  });

  it('prints \\{{ as literal braces', async () => {
    expect(await render('\\{{ name }} {{ name }}', { name: 'Ada' })).toBe('{{ name }} Ada');
  });

  it('strips the BOM', async () => {
    expect(await render('\uFEFF<p>{{ x }}</p>', { x: 1 })).toBe('<p>1</p>');
  });
});

describe('FileTemplateEngine: files', () => {
  it('prefers the locale, then its language, then the default file', async () => {
    const { engine } = setup({
      'hello.html': '<p>Hello</p>',
      'hello.pl.html': '<p>Cześć</p>',
      'hello.pt.html': '<p>Olá</p>',
      'hello.pt-BR.html': '<p>Oi</p>',
    });
    const html = async (locale?: string) => (await engine.render('hello', {}, { locale })).html;
    expect(await html('pl')).toBe('<p>Cześć</p>');
    expect(await html('pt-BR')).toBe('<p>Oi</p>');
    expect(await html('pt-PT')).toBe('<p>Olá</p>');
    expect(await html('de')).toBe('<p>Hello</p>');
    expect(await html(undefined)).toBe('<p>Hello</p>');
  });

  it('renders the .txt template as the text part, found by locale on its own, without escaping', async () => {
    const { engine } = setup({
      'receipt.html': '<p>{{ total }}</p>',
      'receipt.pl.html': '<p>Razem {{ total }}</p>',
      'receipt.txt': 'Total: {{ total }} & {{ note }}',
    });
    const pl = await engine.render('receipt', { total: '$5', note: '<ok>' }, { locale: 'pl' });
    expect(pl).toEqual({ html: '<p>Razem $5</p>', text: 'Total: $5 & <ok>' });
  });

  it('gives no text part without a .txt template', async () => {
    const { engine } = setup({ 'plain.html': '<p>x</p>' });
    expect(await engine.render('plain', {}, { locale: 'pl' })).toEqual({ html: '<p>x</p>' });
  });

  it('removes block tags, comments and partials that stand alone on their lines, as Handlebars does', async () => {
    const { engine } = setup({
      'list.html': '<p>x</p>',
      'list.txt': [
        'Items:',
        '{{! the list }}',
        '{{#each items}}',
        '  - {{ this }}',
        '{{else}}',
        '  (none)',
        '{{/each}}',
        'Total: {{ total }}',
        '    {{> signature}}',
        '{{#if last}}',
        'Bye',
        '{{/if}}',
      ].join('\r\n'),
      'partials/signature.txt': 'The team\nCats {{ total }}\n',
    });
    const { text } = await engine.render('list', { items: ['a', 'b'], total: 5, last: true }, { locale: undefined });
    expect(text).toBe('Items:\r\n  - a\r\n  - b\r\nTotal: 5\r\n    The team\n    Cats 5\nBye\r\n');
  });

  it('keeps block tags that share their line with text', async () => {
    const { engine } = setup({ 'inline.html': 'x', 'inline.txt': 'a {{#if x}}\nb\n{{/if}} c\n{{#if x}}d{{/if}}\n' });
    const { text } = await engine.render('inline', { x: true }, { locale: undefined });
    expect(text).toBe('a \nb\n c\nd\n');
  });

  it('includes partials from partials/, with the context of where they are included', async () => {
    const { engine } = setup({
      'order.html': '<ul>{{#each items}}{{> order/line}}{{/each}}</ul>{{> footer}}',
      'partials/order/line.html': '<li>{{ name }} {{ currency }}</li>',
      'partials/footer.html': '<footer>{{ shop }} {{> legal}}</footer>',
      'partials/footer.pl.html': '<footer>Sklep {{ shop }} {{> legal}}</footer>',
      'partials/legal.html': '&copy;',
    });
    const context = { items: [{ name: 'a' }, { name: 'b' }], currency: 'USD', shop: 'Cats' };
    expect((await engine.render('order', context, { locale: 'en' })).html).toBe(
      '<ul><li>a USD</li><li>b USD</li></ul><footer>Cats &copy;</footer>',
    );
    expect((await engine.render('order', context, { locale: 'pl' })).html).toContain('<footer>Sklep Cats &copy;</footer>');
  });

  it('wraps every mail in the layout, which places it with {{{ body }}} and reads the context', async () => {
    const { engine } = setup(
      {
        'layout.html': '<html><title>{{ title }}</title><body>{{{ body }}}{{> footer}}</body></html>',
        'layout.pl.html': '<html lang="pl">{{ body }}</html>',
        'layout.txt': '{{{ body }}}\n-- {{ title }}',
        'welcome.html': '<p>Hi {{ name }}</p>',
        'welcome.txt': 'Hi {{ name }}',
        'bare.html': '<p>bare</p>',
        'partials/footer.html': '<footer>{{ title }}</footer>',
      },
      { layout: 'layout' },
    );
    expect(await engine.render('welcome', { name: '<Ada>', title: 'Cats' }, { locale: undefined })).toEqual({
      html: '<html><title>Cats</title><body><p>Hi &lt;Ada&gt;</p><footer>Cats</footer></body></html>',
      text: 'Hi <Ada>\n-- Cats',
    });
    // {{ body }} inserts the rendered mail as it is too: it is SafeHtml
    expect((await engine.render('welcome', { name: 'Ada' }, { locale: 'pl' })).html).toBe('<html lang="pl"><p>Hi Ada</p></html>');
    expect(await engine.render('bare', {}, { locale: undefined })).toEqual({
      html: '<html><title></title><body><p>bare</p><footer></footer></body></html>',
    });
  });

  it('leaves the text unwrapped when the layout has no .txt version', async () => {
    const { engine } = setup({ 'layout.html': '<main>{{{ body }}}</main>', 'a.html': 'A', 'a.txt': 'A' }, { layout: 'layout' });
    expect(await engine.render('a', {}, { locale: undefined })).toEqual({ html: '<main>A</main>', text: 'A' });
  });

  it('fails when the layout is missing', async () => {
    const { engine } = setup({ 'a.html': 'A' }, { layout: 'base' });
    await expect(engine.render('a', {}, { locale: 'pl' })).rejects.toThrow(
      /^No layout "base" in .+ \(looked for base\.pl\.html, base\.html\)$/,
    );
  });

  it('names the files it looked for when a template is missing', async () => {
    const { engine, dir } = setup({});
    const error = await rejection(engine.render('orders/confirmation', {}, { locale: 'pt-BR' }));
    expect(error).toBeInstanceOf(MailTemplateError);
    expect(error.message).toBe(
      `No template "orders/confirmation" in ${dir} (looked for orders/confirmation.pt-BR.html, ` +
        'orders/confirmation.pt.html, orders/confirmation.html)',
    );
    expect(error.template).toBe('orders/confirmation');
    expect(error.permanent).toBe(true);
    expect(error).toBeInstanceOf(MailError);
  });

  it('renders templates in folders', async () => {
    const { engine } = setup({ 'orders/shipped.html': 'shipped' });
    expect((await engine.render('orders/shipped', {}, { locale: undefined })).html).toBe('shipped');
  });

  it("rejects names that could leave the directory, or that aren't plain names", async () => {
    const { engine } = setup({ 'ok.html': 'ok' });
    for (const name of ['../secret', '/etc/passwd', 'a/../ok', 'ok.html', 'a//b', 'a\\b', '', ' ok', 'ok/', 42]) {
      const error = await rejection(engine.render(name as string, {}, { locale: undefined }));
      expect(error, String(name)).toBeInstanceOf(MailTemplateError);
      expect(error.message).toMatch(/^Invalid template name/);
    }
  });

  it('rejects a locale that is not a language tag, since it becomes part of a file name', async () => {
    const { engine } = setup({ 'ok.html': 'ok' });
    for (const locale of ['../x', 'pl/../../x', 'pl.html', '', 'pl-']) {
      await expect(engine.render('ok', {}, { locale }), locale).rejects.toThrow(`Invalid locale "${locale}" for the template "ok"`);
    }
    expect((await engine.render('ok', {}, { locale: 'zh_Hant_TW' })).html).toBe('ok');
  });

  it('checks its options', () => {
    expect(() => new FileTemplateEngine(undefined as never)).toThrow('FileTemplateEngine needs `dir`');
    expect(() => new FileTemplateEngine({ dir: '' })).toThrow('FileTemplateEngine needs `dir`');
    expect(() => new FileTemplateEngine({ dir: 'x', layout: '../layout' })).toThrow('`layout` must be a template name');
    expect(() => new FileTemplateEngine({ dir: 'x', cache: 'no' as never })).toThrow('`cache` must be a boolean');
  });

  it('resolves a relative dir against the working directory', async () => {
    const { dir } = setup({ 'cwd.html': 'from cwd' });
    const engine = new FileTemplateEngine({ dir: relative(process.cwd(), dir) });
    expect((await engine.render('cwd', {}, { locale: undefined })).html).toBe('from cwd');
  });
});

describe('FileTemplateEngine: cache', () => {
  it('keeps compiled templates and missing files by default', async () => {
    const { engine, write } = setup({ 'a.html': 'one' });
    expect((await engine.render('a', {}, { locale: 'pl' })).html).toBe('one');

    write('a.html', 'two');
    write('a.pl.html', 'polish');
    write('a.txt', 'text');
    expect(await engine.render('a', {}, { locale: 'pl' })).toEqual({ html: 'one' });
  });

  it('reads the files on every render with cache: false', async () => {
    const { engine, write } = setup({ 'a.html': 'one', 'partials/p.html': 'p1', 'b.html': '{{> p}}' }, { cache: false });
    expect((await engine.render('a', {}, { locale: 'pl' })).html).toBe('one');
    expect((await engine.render('b', {}, { locale: undefined })).html).toBe('p1');

    write('a.html', 'two');
    write('partials/p.html', 'p2');
    expect((await engine.render('a', {}, { locale: undefined })).html).toBe('two');
    expect((await engine.render('b', {}, { locale: undefined })).html).toBe('p2');

    write('a.pl.html', 'polish');
    write('a.txt', 'text');
    expect(await engine.render('a', {}, { locale: 'pl' })).toEqual({ html: 'polish', text: 'text' });
  });

  it("doesn't keep a template that failed to compile", async () => {
    const { engine, write } = setup({ 'a.html': '{{#if x}}' });
    await expect(engine.render('a', {}, { locale: undefined })).rejects.toThrow('a.html:1:1: {{#if x}} is never closed');

    write('a.html', '{{#if x}}fixed{{/if}}');
    expect((await engine.render('a', { x: 1 }, { locale: undefined })).html).toBe('fixed');
  });
});

describe('FileTemplateEngine: compile errors', () => {
  const cases: [string, string, string][] = [
    ['an unclosed block', '<p>\n  {{#each items}}{{ name }}', 't.html:2:3: {{#each items}} is never closed (expected {{/each}})'],
    [
      'a mismatched close',
      '{{#if a}}\n{{#each b}}\n{{/if}}',
      't.html:3:1: {{/if}} closes {{#each b}}, opened at 2:1',
    ],
    ['a close without a block', 'x {{/if}}', "t.html:1:3: {{/if}} doesn't close any block"],
    ['a second else', '{{#if a}}1{{else}}2{{else}}3{{/if}}', 't.html:1:20: a second {{else}} in {{#if a}}, opened at 1:1'],
    ['an else outside a block', 'a{{else}}', 't.html:1:2: {{else}} outside of a block'],
    ['an unknown else', '{{#if a}}{{else each b}}{{/if}}', 't.html:1:10: unknown syntax {{else each b}}: else is followed by nothing, if or unless'],
    ['an unknown block helper', '\n\n   {{#with order}}{{/with}}', 't.html:3:4: unknown block helper {{#with order}}: the blocks are #if, #unless and #each'],
    ['a helper call', 'Total: {{ formatPrice total }}', "t.html:1:8: helpers aren't supported ({{ formatPrice total }}): prepare the value in the mail class"],
    ['a block with a helper', '{{#if (eq a b)}}{{/if}}', "t.html:1:1: {{#if (eq a b)}} takes one value: helpers and hash arguments aren't supported"],
    ['a block without a value', '{{#each}}{{/each}}', 't.html:1:1: {{#each}} needs a value, as in {{#each items}}'],
    ['block parameters', '{{#each items as |item|}}{{/each}}', "t.html:1:1: block parameters (as |item|) aren't supported: inside {{#each}}, the item is this"],
    ['a literal', '{{ "text" }}', 't.html:1:1: unknown syntax {{ "text" }}'],
    ['an empty tag', 'a {{ }}', 't.html:1:3: unknown syntax {{  }}'],
    ['a bad path', '{{ a..b }}', 't.html:1:1: unknown syntax {{ a..b }}'],
    ['this in the middle of a path', '{{ a.this }}', 't.html:1:1: unknown syntax {{ a.this }}'],
    ['an unknown data variable', '{{#each a}}{{ @count }}{{/each}}', 't.html:1:12: unknown data variable @count: there are @index, @first, @last, @key and @root'],
    ['an unclosed {{', '<p>{{ name </p>', 't.html:1:4: {{ is never closed (expected }})'],
    ['an unclosed {{{', '{{{ raw }}', 't.html:1:1: {{{ is never closed (expected }}})'],
    ['an unclosed comment', '{{!-- x }}', 't.html:1:1: {{!-- is never closed (expected --}})'],
    ['whitespace control', '{{~ name }}', "t.html:1:1: whitespace control (~) isn't supported: {{~ name}}"],
    ['partial arguments', '{{> footer order}}', 't.html:1:1: {{> footer order}}: a partial takes no arguments, it reads the context it is included in'],
    ['a bad partial name', '{{> ../secret}}', 't.html:1:1: invalid partial name {{> ../secret}}: use letters, digits, "-" and "_", with "/" between folders'],
    ['a missing partial', '<p>\n{{> footer}}</p>', 't.html:2:1: no partial "footer" (looked for partials/footer.html)'],
  ];

  it.each(cases)('reports %s with its position', async (_, source, message) => {
    const error = await failure(source);
    expect(error.message).toBe(message);
    const [, line, column] = /:(\d+):(\d+):/.exec(message)!;
    expect(error).toMatchObject({ line: Number(line), column: Number(column), permanent: true });
    expect(error.file).toMatch(/nestjs-mail-templates-\w+\/t\.html$/);
  });

  it('counts lines across CRLF line endings', async () => {
    expect((await failure('a\r\nb\r\n  {{#if x}}')).message).toBe('t.html:3:3: {{#if x}} is never closed (expected {{/if}})');
  });

  it('names the partial the problem is in', async () => {
    const { engine } = setup({ 'a.html': '{{> broken}}', 'partials/broken.html': 'ok\n{{#if x}}' });
    await expect(engine.render('a', {}, { locale: undefined })).rejects.toThrow(
      'partials/broken.html:2:1: {{#if x}} is never closed (expected {{/if}})',
    );
  });

  it('stops a partial that includes itself', async () => {
    const { engine } = setup({ 'a.html': '{{> loop}}', 'partials/loop.html': 'x{{#if go}}{{> loop}}{{/if}}' });
    expect((await engine.render('a', { go: false }, { locale: undefined })).html).toBe('x');
    await expect(engine.render('a', { go: true }, { locale: undefined })).rejects.toThrow(
      'partials/loop.html:1:12: partials are nested more than 32 deep here: does {{> loop}} include itself?',
    );
  });
});

describe('FileTemplateEngine: values inside tags', () => {
  it('refuses an escaped value in an unquoted attribute, and says to quote it', async () => {
    expect((await failure('<a class="x"\n   href={{ url }}>')).message).toBe(
      't.html:2:9: quote the attribute value {{ url }} goes into (write attr="{{ url }}")',
    );
  });

  it('refuses an escaped value between attributes', async () => {
    expect((await failure('<td {{ attrs }}>')).message).toBe(
      "t.html:1:5: {{ attrs }} is inside a tag but not in a quoted attribute value, where escaping can't protect it",
    );
    expect((await failure('<td {{#if right}}align="right"{{/if}} {{ extra }}>')).message).toMatch(/^t\.html:1:39: \{\{ extra \}\} is inside a tag/);
  });

  it('allows values in quoted attributes, element content, comments, and raw values anywhere', async () => {
    const out = await render(
      `<a href="{{ url }}" title='{{ title }}' {{{ attrs }}} class="{{#if on}}on{{/if}}">{{ text }}</a><!-- {{ note }} --> 1 < 2 {{ n }}`,
      { url: 'https://x/?a=1&b=2', title: "it's", attrs: 'data-x="1"', on: true, text: '<t>', note: 'n', n: 3 },
    );
    expect(out).toBe(
      `<a href="https://x/?a=1&amp;b=2" title='it&#39;s' data-x="1" class="on">&lt;t&gt;</a><!-- n --> 1 < 2 3`,
    );
  });

  it("doesn't check .txt templates, which aren't HTML", async () => {
    const { engine } = setup({ 'a.html': 'a', 'a.txt': '<a href={{ url }}>' });
    expect((await engine.render('a', { url: 'x y' }, { locale: undefined })).text).toBe('<a href=x y>');
  });
});
