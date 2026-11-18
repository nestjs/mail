import { Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import ical, { ICalAttendeeRole, ICalCalendarMethod, ICalEventStatus } from 'ical-generator';
import {
  html,
  InMemoryMailTransport,
  type Mailable,
  Mailer,
  MailMessageError,
  MailModule,
  PostmarkTransport,
  ResendTransport,
  SendGridTransport,
  SesTransport,
} from '../lib/index.js';
import { leaves, lint, parseMessage } from './support/mime-parser.js';

interface DeliverySlotChange {
  uid?: string;
  revision: number;
  cancelled?: boolean;
  description?: string;
  attendees?: { name: string; email: string }[];
}

const START = new Date(Date.UTC(2026, 11, 1, 13, 0, 0));
const END = new Date(Date.UTC(2026, 11, 1, 15, 0, 0));
const STAMP = new Date(Date.UTC(2026, 10, 18, 12, 0, 0));

/** A mail class that builds its event with ical-generator in render(), as an application does. */
@Injectable()
class DeliverySlotMail implements Mailable<DeliverySlotChange> {
  render({ uid = 'delivery-1001@shop.example.com', revision, cancelled = false, description, attendees }: DeliverySlotChange) {
    const calendar = ical({
      prodId: '//Example Shop//Orders//EN',
      method: cancelled ? ICalCalendarMethod.CANCEL : ICalCalendarMethod.REQUEST,
    });
    calendar.createEvent({
      id: uid,
      sequence: revision,
      stamp: STAMP,
      start: START,
      end: END,
      summary: 'Delivery of order #1001',
      ...(description !== undefined && { description }),
      status: cancelled ? ICalEventStatus.CANCELLED : ICalEventStatus.CONFIRMED,
      organizer: { name: 'Example Shop', email: 'orders@shop.example.com' },
      attendees: (attendees ?? [{ name: 'Ada Lovelace', email: 'ada@example.com' }]).map((a) => ({
        ...a,
        rsvp: true,
        role: ICalAttendeeRole.REQ,
      })),
    });

    return {
      subject: cancelled ? 'Delivery cancelled' : 'Delivery of order #1001',
      html: html`<p>Your delivery</p>`,
      calendar: { content: calendar.toString() },
    };
  }
}

const unfold = (content: string) => content.replace(/\r\n[ \t]/g, '');

describe('calendar invitations built with ical-generator', () => {
  let moduleRef: TestingModule;
  let mailer: Mailer;
  const mailbox = new InMemoryMailTransport();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [MailModule.forRoot({ transport: mailbox, from: 'Example Shop <orders@shop.example.com>' })],
      providers: [DeliverySlotMail],
    }).compile();
    await moduleRef.init();
    mailer = moduleRef.get(Mailer);
  });
  afterAll(() => moduleRef.close());
  beforeEach(() => mailbox.clear());

  it('sends the method that ical-generator wrote into the calendar, without the method option', async () => {
    await mailer.send(DeliverySlotMail, { to: 'ada@example.com', data: { revision: 0 } });

    const mail = mailbox.assertSent({ mail: DeliverySlotMail });
    expect(mail.calendar).toMatchObject({ method: 'REQUEST', filename: 'invite.ics' });
    expect(mail.calendar?.content).toContain('METHOD:REQUEST\r\n');
    expect(mail.calendar?.content).toContain('UID:delivery-1001@shop.example.com\r\n');
    expect(mail.calendar?.content).toContain('SEQUENCE:0\r\n');
  });

  it('keeps the calendar ical-generator wrote byte for byte through the MIME, in the part and in its copy', async () => {
    await mailer.send(DeliverySlotMail, { to: 'ada@example.com', data: { revision: 0 } });

    const mail = mailbox.assertSent();
    expect(lint(mail.raw)).toEqual([]);
    const tree = parseMessage(mail.raw);
    expect(tree.type).toBe('multipart/mixed');
    expect(tree.parts[0].parts.map((p) => p.type)).toEqual(['text/plain', 'text/html', 'text/calendar']);

    const [event, copy] = [tree.parts[0].parts[2], tree.parts[1]];
    expect(event.params).toEqual({ charset: 'utf-8', method: 'REQUEST' });
    expect(copy.type).toBe('application/ics');
    expect(event.body.toString('utf8')).toBe(mail.calendar?.content);
    expect(copy.body.toString('utf8')).toBe(mail.calendar?.content);
  });

  it('survives the long lines ical-generator folds, and the characters it escapes and encodes', async () => {
    const description = `Leave it at the door.\nPaczka dla Zoë, Łukasiewicz; piętro 3, mieszkanie 12. ${'Dziękujemy! '.repeat(30)}`;
    const attendees = [{ name: `Zoë Łukasiewicz-Wiśniewska ${'Długie Nazwisko '.repeat(4)}`, email: 'zoe@example.com' }];
    await mailer.send(DeliverySlotMail, { to: 'zoe@example.com', data: { revision: 0, description, attendees } });

    const mail = mailbox.assertSent();
    const content = mail.calendar!.content;
    expect(content.split('\r\n').some((line) => line.startsWith(' '))).toBe(true);
    expect(unfold(content)).toContain('Leave it at the door.\\nPaczka dla Zoë\\, Łukasiewicz\\; piętro 3');
    expect(lint(mail.raw)).toEqual([]);

    const tree = parseMessage(mail.raw);
    const [event, copy] = [tree.parts[0].parts[2], tree.parts[1]];
    expect(event.body.toString('utf8')).toBe(content);
    expect(copy.body.toString('utf8')).toBe(content);
    expect(header(event, 'content-transfer-encoding')).toBe('quoted-printable');
  });

  it('moves and cancels the same event: one UID, a higher SEQUENCE each time, and the method of the calendar', async () => {
    await mailer.send(DeliverySlotMail, { to: 'ada@example.com', data: { revision: 0 } });
    await mailer.send(DeliverySlotMail, { to: 'ada@example.com', data: { revision: 1 } });
    await mailer.send(DeliverySlotMail, { to: 'ada@example.com', data: { revision: 2, cancelled: true } });

    const sent = mailbox.mails.map((mail) => mail.calendar!);
    expect(sent.map((c) => c.method)).toEqual(['REQUEST', 'REQUEST', 'CANCEL']);
    expect(sent.map((c) => /SEQUENCE:(\d+)/.exec(c.content)![1])).toEqual(['0', '1', '2']);
    expect(new Set(sent.map((c) => /UID:(\S+)/.exec(c.content)![1]))).toEqual(new Set(['delivery-1001@shop.example.com']));
    expect(sent[2].content).toContain('STATUS:CANCELLED\r\n');
    expect(leaves(parseMessage(mailbox.assertSent({ subject: 'Delivery cancelled' }).raw))[2].params.method).toBe('CANCEL');
  });

  it('accepts a method that agrees with the calendar, and refuses one that does not', async () => {
    const calendar = ical({ prodId: '//Example Shop//Orders//EN', method: ICalCalendarMethod.REQUEST });
    calendar.createEvent({ id: 'e@shop.example.com', start: START, end: END, stamp: STAMP, summary: 'Delivery' });
    const content = calendar.toString();

    const agreed = await mailer.render({ to: 'ada@example.com', subject: 's', text: 't', calendar: { content, method: 'REQUEST' } });
    expect(agreed.calendar?.method).toBe('REQUEST');

    const error = await mailer
      .render({ to: 'ada@example.com', subject: 's', text: 't', calendar: { content, method: 'CANCEL' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailMessageError);
    expect(error).toMatchObject({
      field: 'calendar.method',
      message: 'Invalid mail: calendar.method is CANCEL, but the content says METHOD:REQUEST: they must agree, or clients drop the invitation',
    });
  });

  it('takes a calendar without a method, which ical-generator writes when none is given', async () => {
    const calendar = ical({ prodId: '//Example Shop//Orders//EN' });
    calendar.createEvent({ id: 'e@shop.example.com', start: START, end: END, stamp: STAMP, summary: 'Delivery' });

    const message = await mailer.render({ subject: 's', text: 't', calendar: { content: calendar.toString() } });
    expect(message.calendar?.method).toBeUndefined();
    expect(leaves(parseMessage(message.toMime().toString('utf8')))[1].params).toEqual({ charset: 'utf-8' });
  });

  it('takes the calendar as UTF-8 bytes', async () => {
    const calendar = ical({ prodId: '//Example Shop//Orders//EN', method: ICalCalendarMethod.PUBLISH });
    calendar.createEvent({ id: 'e@shop.example.com', start: START, end: END, stamp: STAMP, summary: 'Open day: Dzień otwarty' });

    const message = await mailer.render({ subject: 's', text: 't', calendar: { content: new TextEncoder().encode(calendar.toString()) } });
    expect(message.calendar?.method).toBe('PUBLISH');
    expect(message.calendar?.content).toContain('SUMMARY:Open day: Dzień otwarty');
  });

  describe('through every transport', () => {
    const send = { signal: new AbortController().signal, attempt: 1 };

    async function invitation() {
      return mailer.render(DeliverySlotMail, { to: 'ada@example.com', data: { revision: 3, description: 'Ring twice; leave it at the door.' } });
    }

    function stubFetch(body: unknown, init?: ResponseInit) {
      const requests: { url: string; body: any }[] = [];
      const fetch = (async (url: string, request: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(request.body)) });
        return Response.json(body, init);
      }) as typeof globalThis.fetch;
      return { fetch, requests };
    }

    const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

    it('SES sends the whole MIME message', async () => {
      const message = await invitation();
      const { fetch, requests } = stubFetch({ MessageId: 'm' });
      await new SesTransport({
        region: 'eu-west-1',
        credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
        fetch,
      }).send(message, send);

      const raw = Buffer.from(requests[0].body.Content.Raw.Data, 'base64');
      expect(raw.equals(message.toMime())).toBe(true);
      expect(leaves(parseMessage(raw.toString('utf8'))).map((p) => p.type)).toEqual([
        'text/plain',
        'text/html',
        'text/calendar',
        'application/ics',
      ]);
    });

    it('SendGrid sends a text/calendar content entry with the method, and the copy', async () => {
      const message = await invitation();
      const { fetch, requests } = stubFetch({}, { status: 202 });
      await new SendGridTransport({ apiKey: 'SG.key', fetch }).send(message, send);

      const [{ body }] = requests;
      expect(body.content.map((c: { type: string }) => c.type)).toEqual(['text/plain', 'text/html', 'text/calendar; method=REQUEST']);
      expect(body.content[2].value).toBe(message.calendar!.content);
      expect(body.attachments).toEqual([
        { content: base64(message.calendar!.content), filename: 'invite.ics', type: 'application/ics', disposition: 'attachment' },
      ]);
    });

    it('Resend sends one text/calendar attachment with the method', async () => {
      const message = await invitation();
      const { fetch, requests } = stubFetch({ id: 'r' });
      await new ResendTransport({ apiKey: 're_test', fetch }).send(message, send);

      expect(requests[0].body.attachments).toEqual([
        { filename: 'invite.ics', content: base64(message.calendar!.content), content_type: 'text/calendar; charset=utf-8; method=REQUEST' },
      ]);
    });

    it('Postmark sends one text/calendar attachment with the method', async () => {
      const message = await invitation();
      const { fetch, requests } = stubFetch({ MessageID: 'p' });
      await new PostmarkTransport({ serverToken: 'pm', fetch }).send(message, send);

      expect(requests[0].body.Attachments).toEqual([
        { Name: 'invite.ics', Content: base64(message.calendar!.content), ContentType: 'text/calendar; charset=utf-8; method=REQUEST' },
      ]);
    });

  });
});

function header(part: { headers: [string, string][] }, name: string): string | undefined {
  return part.headers.find(([n]) => n.toLowerCase() === name)?.[1];
}
