import { html, unsafeHtml } from '../lib/index.js';
import { escapeHtml, isSafeHtml } from '../lib/message/html.util.js';
import { decodeEntities, extractLinks, htmlToText } from '../lib/message/text.util.js';

describe('html template values', () => {
  it('renders true and bigint as text, and escapes objects through String()', () => {
    const value = { toString: () => '<i>obj</i>' };
    expect(html`<p>${true} ${10n} ${value as never}</p>`.value).toBe('<p>true 10 &lt;i&gt;obj&lt;/i&gt;</p>');
  });

  it('renders nested arrays, skipping null and false items', () => {
    expect(html`<p>${['a', null, ['<b>', false, html`<i>c</i>`]]}</p>`.value).toBe('<p>a&lt;b&gt;<i>c</i></p>');
  });

  it('gives the same string from value, String() and a template literal', () => {
    const safe = html`<b>${'x'}</b>`;
    expect(String(safe)).toBe('<b>x</b>');
    expect(`${safe}`).toBe('<b>x</b>');
    expect(Object.isFrozen(safe)).toBe(true);
  });

  it('recognizes SafeHtml by its global brand, so a copy of the package agrees', () => {
    expect(isSafeHtml(html`x`)).toBe(true);
    expect(isSafeHtml({ value: 'x', [Symbol.for('@nestjs/mail:safe-html')]: true })).toBe(true);
    expect(isSafeHtml({ value: 'x', [Symbol('@nestjs/mail:safe-html')]: true })).toBe(false);
    expect(isSafeHtml('x')).toBe(false);
    expect(isSafeHtml(null)).toBe(false);
  });

  it('unsafeHtml() takes strings only', () => {
    expect(() => unsafeHtml(42 as never)).toThrow('unsafeHtml() takes a string');
  });

  it('allows a value right after a tag closed, in a single-quoted attribute, and after an end tag', () => {
    expect(html`<b>${'a'}</b>${'<'}<a title='${"it's"}'>x</a>`.value).toBe('<b>a</b>&lt;<a title=\'it&#39;s\'>x</a>');
  });

  it('names the interpolation that is in the wrong place', () => {
    expect(() => html`<p>${'ok'}</p><a href=${'x'}>`).toThrow(/interpolation #2/);
  });

  it('escapeHtml() escapes the five characters that matter, nothing else', () => {
    expect(escapeHtml(`&<>"' zażółć /=\``)).toBe('&amp;&lt;&gt;&quot;&#39; zażółć /=`');
  });
});

describe('entities', () => {
  it('decodes numeric references, decimal and hex, and the common named ones', () => {
    expect(decodeEntities('&#65;&#x42;&#X43; &euro;&hellip;&MDASH; &copy;')).toBe('ABC €…— ©');
  });

  it('leaves unknown names and invalid code points as they are', () => {
    expect(decodeEntities('&bogus; &#0; &#xD800; &#x110000; & amp;')).toBe('&bogus; &#0; &#xD800; &#x110000; & amp;');
  });
});

describe('htmlToText()', () => {
  it('keeps the label only for fragment and javascript: links', () => {
    expect(htmlToText('<a href="#top">Top</a> <a href="javascript:alert(1)">Click</a>')).toBe('Top Click');
  });

  it('shows a link once when its label is its target', () => {
    expect(htmlToText('<a href="https://a.example/x">https://a.example/x</a>')).toBe('https://a.example/x');
    expect(htmlToText('<a href="mailto:help@example.com">help@example.com</a>')).toBe('help@example.com');
    expect(htmlToText('<a href="https://a.example/x"><img src="cid:logo"></a>')).toBe('https://a.example/x');
  });

  it('reads single-quoted and unquoted href attributes, entities decoded', () => {
    expect(htmlToText("<a href='https://a.example/?a=1&amp;b=2'>A</a> <a href=https://b.example>B</a>")).toBe(
      'A (https://a.example/?a=1&b=2) B (https://b.example)',
    );
  });

  it('turns hr into a rule and a br into a line break, and never leaves more than one blank line', () => {
    expect(htmlToText('<div>one<br>two</div><hr><p>three</p><p></p><p></p><p>four</p>')).toBe('one\ntwo\n\n----\n\nthree\n\nfour');
  });

  it('drops head, style, script and title whatever their case', () => {
    expect(htmlToText('<HEAD><TITLE>t</TITLE></HEAD><SCRIPT>x()</SCRIPT><Style>p{}</Style><P>Body</P>')).toBe('Body');
  });

  it('turns table rows into lines', () => {
    expect(htmlToText('<table><tr><th>Item</th><th>Qty</th></tr><tr><td>Dune</td><td>2</td></tr></table>')).toBe('Item Qty\nDune 2');
  });
});

describe('extractLinks()', () => {
  it('ignores links inside HTML comments', () => {
    expect(extractLinks('<!-- <a href="https://hidden.example">x</a> --><a href="https://shown.example">y</a>', undefined)).toEqual([
      'https://shown.example',
    ]);
  });

  it('skips javascript: and empty hrefs, and keeps a link once', () => {
    expect(
      extractLinks('<a href="javascript:void(0)">x</a><a href="">e</a><a href="https://a.example">a</a><a href="https://a.example">again</a>', undefined),
    ).toEqual(['https://a.example']);
  });

  it('strips trailing punctuation from text links, but keeps it inside the URL', () => {
    expect(extractLinks(undefined, 'Go to https://a.example/x?y=1!, or http://b.example/a.b; (https://c.example/p).')).toEqual([
      'https://a.example/x?y=1',
      'http://b.example/a.b',
      'https://c.example/p',
    ]);
  });

  it('finds nothing in empty bodies', () => {
    expect(extractLinks(undefined, undefined)).toEqual([]);
    expect(extractLinks('', '')).toEqual([]);
  });
});
