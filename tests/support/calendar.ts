/**
 * A small iCalendar (RFC 5545) invitation for the calendar tests, with CRLF line breaks.
 * `method: null` leaves the `METHOD` property out.
 */
export function invitation({
  method = 'REQUEST',
  summary = 'Order review',
  sequence = 0,
}: { method?: string | null; summary?: string; sequence?: number } = {}): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Example Corp//Scheduling//EN',
    ...(method === null ? [] : [`METHOD:${method}`]),
    'BEGIN:VEVENT',
    'UID:meeting-42@example.com',
    `SEQUENCE:${sequence}`,
    'DTSTAMP:20260922T180000Z',
    'DTSTART:20261001T090000Z',
    'DTEND:20261001T100000Z',
    `SUMMARY:${summary}`,
    'ORGANIZER;CN=Orders:mailto:orders@example.com',
    'ATTENDEE;CN=Ada;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto',
    ' :ada@example.com',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
