import { InMemoryMailTransport, MailConnectionError, SentMail } from '../lib/index.js';
import { createMailMessage, type NormalizeInput } from '../lib/message/normalize.util.js';
import { parseMessage } from './support/mime-parser.js';

class WelcomeMail {
  render() {
    return { subject: 'Welcome', text: 'Hi' };
  }
}

function message(input: Partial<NormalizeInput> = {}) {
  return createMailMessage({ to: 'ada@example.com', subject: 'Hello', text: 'Hi', ...input }, { from: 'Orders <orders@example.com>' });
}

describe('InMemoryMailTransport', () => {
  let mailbox: InMemoryMailTransport;
  beforeEach(() => {
    mailbox = new InMemoryMailTransport();
  });

  it('accepts every envelope recipient and records a SentMail with the time it was sent', async () => {
    const before = Date.now();
    const result = await mailbox.send(await message({ cc: 'cc@example.com', bcc: 'bcc@example.com' }));

    expect(result).toEqual({ accepted: ['ada@example.com', 'cc@example.com', 'bcc@example.com'] });
    const [mail] = mailbox.mails;
    expect(mail).toBeInstanceOf(SentMail);
    expect(mail.sentAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('returns a copy of the mails, so a test cannot change what was recorded', async () => {
    await mailbox.send(await message());
    (mailbox.mails as SentMail[]).length = 0;
    expect(mailbox.mails).toHaveLength(1);
  });

  it('matches `to` against to, cc and bcc, ignoring case', async () => {
    await mailbox.send(await message({ to: 'a@example.com', cc: 'Carol@Example.com', bcc: 'hidden@example.com' }));

    expect(mailbox.find({ to: 'A@EXAMPLE.COM' })).toBeDefined();
    expect(mailbox.find({ to: 'carol@example.com' })).toBeDefined();
    expect(mailbox.find({ to: 'hidden@example.com' })).toBeDefined();
    expect(mailbox.find({ to: 'other@example.com' })).toBeUndefined();
  });

  it('matches the subject exactly as a string, and by test() as a RegExp', async () => {
    await mailbox.send(await message({ subject: 'Order #42 shipped' }));

    expect(mailbox.find({ subject: 'Order #42' })).toBeUndefined();
    expect(mailbox.find({ subject: 'Order #42 shipped' })).toBeDefined();
    expect(mailbox.find({ subject: /order #\d+/i })).toBeDefined();
  });

  it('needs every field of a query to match', async () => {
    await mailbox.send(await message({ to: 'a@example.com', subject: 'One' }));
    await mailbox.send(await message({ to: 'b@example.com', subject: 'Two' }));

    expect(mailbox.filter({ to: 'a@example.com', subject: 'Two' })).toEqual([]);
    expect(mailbox.filter({ to: 'b@example.com', subject: 'Two' }).map((m) => m.subject)).toEqual(['Two']);
  });

  it('matches the mail class that rendered it', async () => {
    await mailbox.send(await message({ mail: WelcomeMail }));
    await mailbox.send(await message());

    expect(mailbox.filter({ mail: WelcomeMail })).toHaveLength(1);
    expect(mailbox.filter({ mail: class Other {} })).toEqual([]);
  });

  it('takes a predicate', async () => {
    await mailbox.send(await message({ subject: 'a' }));
    await mailbox.send(await message({ subject: 'b', attachments: [{ filename: 'x.txt', content: 'x' }] }));

    expect(mailbox.filter((mail) => mail.attachments.length > 0).map((m) => m.subject)).toEqual(['b']);
  });

  it('filter() lists oldest first, find() and assertSent() return the most recent', async () => {
    for (const subject of ['first', 'second', 'third']) {
      await mailbox.send(await message({ subject }));
    }

    expect(mailbox.filter().map((m) => m.subject)).toEqual(['first', 'second', 'third']);
    expect(mailbox.find()?.subject).toBe('third');
    expect(mailbox.assertSent({ to: 'ada@example.com' }).subject).toBe('third');
  });

  it('describes the query and says when nothing was sent at all', () => {
    expect(() => mailbox.assertSent({ mail: WelcomeMail, to: 'a@example.com', subject: /welcome/ })).toThrow(
      'Expected a mail rendered by WelcomeMail to a@example.com with subject /welcome/, but none was sent. No mail was sent.',
    );
    expect(() => mailbox.assertSent((mail) => mail.subject === 'x')).toThrow(/Expected a mail matching the predicate, but none was sent/);
  });

  it('assertNotSent() without a query fails on any mail, naming it', async () => {
    mailbox.assertNotSent();
    await mailbox.send(await message({ subject: 'Oops', to: ['a@example.com', 'b@example.com'] }));

    expect(() => mailbox.assertNotSent()).toThrow(/Expected no mail , but "Oops" was sent\. Sent:\n {2}- "Oops" to a@example\.com, b@example\.com$/);
    expect(() => mailbox.assertNotSent({ to: 'c@example.com' })).not.toThrow();
  });

  it('failNext() fails one send per queued error, in order, without recording it', async () => {
    const first = new MailConnectionError('down', { permanent: false });
    const second = new Error('still down');
    mailbox.failNext(first);
    mailbox.failNext(second);

    await expect(mailbox.send(await message())).rejects.toBe(first);
    await expect(mailbox.send(await message())).rejects.toBe(second);
    await expect(mailbox.send(await message())).resolves.toBeDefined();
    expect(mailbox.mails).toHaveLength(1);
  });

  it('clear() also forgets pending failures', async () => {
    mailbox.failNext(new Error('x'));
    mailbox.clear();
    await expect(mailbox.send(await message())).resolves.toBeDefined();
  });
});

describe('SentMail', () => {
  async function sent(input: Partial<NormalizeInput>) {
    const mailbox = new InMemoryMailTransport();
    await mailbox.send(await message(input));
    return mailbox.assertSent();
  }

  it('exposes the message fields', async () => {
    const mail = await sent({
      to: 'Ada <ada@example.com>',
      cc: 'cc@example.com',
      bcc: 'bcc@example.com',
      headers: { 'X-Tag': 't' },
      locale: 'pl',
      mail: WelcomeMail,
    });

    expect(mail.messageId).toBe(mail.message.messageId);
    expect(mail.from).toEqual({ name: 'Orders', address: 'orders@example.com' });
    expect(mail.to).toEqual([{ name: 'Ada', address: 'ada@example.com' }]);
    expect(mail.cc).toEqual([{ address: 'cc@example.com' }]);
    expect(mail.bcc).toEqual([{ address: 'bcc@example.com' }]);
    expect(mail.headers).toEqual({ 'X-Tag': 't' });
    expect(mail.locale).toBe('pl');
    expect(mail.mail).toBe(WelcomeMail);
    expect(mail.html).toBeUndefined();
    expect(mail.text).toBe('Hi');
  });

  it('gives the MIME source, which has no Bcc', async () => {
    const mail = await sent({ bcc: 'bcc@example.com' });
    const parsed = parseMessage(mail.raw);
    expect(parsed.headers.find(([name]) => name === 'Message-ID')?.[1]).toBe(mail.messageId);
    expect(mail.raw).not.toContain('bcc@example.com');
  });

  it('link() without a match returns the first link, and fails when there is none', async () => {
    const mail = await sent({ html: '<a href="https://a.example/1">1</a><a href="https://a.example/2">2</a>' });
    expect(mail.link().href).toBe('https://a.example/1');
    expect(mail.link(/\/2$/).href).toBe('https://a.example/2');

    const plain = await sent({ subject: 'Plain', text: 'No links here' });
    expect(() => plain.link()).toThrow('No link in the mail "Plain". Links: none');
  });

  it('link() refuses a relative link, which a recipient could not open', async () => {
    const mail = await sent({ subject: 'Reset', html: '<a href="/reset?token=abc">Reset</a>' });
    expect(mail.links).toEqual(['/reset?token=abc']);
    expect(() => mail.link('/reset')).toThrow(/The link "\/reset\?token=abc" in the mail "Reset" is not absolute/);
  });

  it('links come from the html first, then the text, once each', async () => {
    const mail = await sent({
      html: '<a href="https://a.example/x">x</a>',
      text: 'See https://a.example/x and https://b.example/y.',
    });
    expect(mail.links).toEqual(['https://a.example/x', 'https://b.example/y']);
  });

  it('attachment() finds by filename and lists what there is when it fails', async () => {
    const mail = await sent({
      subject: 'Invoice',
      html: '<img src="cid:logo">',
      attachments: [
        { cid: 'logo', content: 'png' },
        { filename: 'invoice.pdf', content: '%PDF' },
      ],
    });

    expect(mail.attachment('invoice.pdf').content.toString()).toBe('%PDF');
    expect(() => mail.attachment('terms.pdf')).toThrow('No attachment "terms.pdf" in the mail "Invoice". Attachments: cid:logo, invoice.pdf');

    const none = await sent({ subject: 'Bare' });
    expect(() => none.attachment('a.pdf')).toThrow('Attachments: none');
  });
});
