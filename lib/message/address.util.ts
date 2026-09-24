import { domainToASCII } from 'node:url';
import { MailMessageError } from '../errors/mail-message.error.js';
import type { MailAddress, MailAddressInput } from '../interfaces/mail-message.interface.js';

/** RFC 5322 `atext`, plus any non-ASCII character (RFC 6532). */
const ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~\-\u{80}-\u{10FFFF}]+$/u;
const LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;
/** C0 controls (tab included: never meaningful in an address or a name), DEL, and C1 controls. */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Characters an unquoted display name can't contain without changing how the header parses. */
const PHRASE_SPECIALS = /[()<>[\]:;@\\,"]/;

/**
 * One address, strictly: a string holding two addresses (`'a@x.com, b@y.com'`) or a
 * display name with an unquoted comma is refused, so a name that came from user input
 * can never add a recipient. Objects are the safe way to pass a name you don't control:
 * `{ name: user.fullName, address: user.email }` is always encoded as one name.
 */
export function parseAddress(input: MailAddressInput, field: string): MailAddress {
  if (typeof input === 'object' && input !== null) {
    if (typeof input.address !== 'string') {
      throw new MailMessageError(field, 'must be a string or { name?, address }');
    }
    const address = parseAddrSpec(input.address.trim(), `${field}.address`);
    if (input.name === undefined || input.name === '') {
      return { address };
    }
    if (typeof input.name !== 'string') {
      throw new MailMessageError(`${field}.name`, 'must be a string');
    }
    return { name: checkName(input.name, `${field}.name`), address };
  }

  if (typeof input !== 'string') {
    throw new MailMessageError(field, 'must be a string or { name?, address }');
  }
  if (CONTROL.test(input)) {
    throw new MailMessageError(field, 'contains a line break or another control character');
  }

  const value = input.trim();
  if (!value.endsWith('>')) {
    if (value.includes('<') || value.includes(',') || value.includes(';')) {
      throw new MailMessageError(
        field,
        'must be a single address. Pass several recipients as an array, and a name as ' +
          '"Name <address>" or { name, address }',
      );
    }
    return { address: parseAddrSpec(value, field) };
  }

  const open = findAngleOpen(value);
  if (open === -1) {
    throw new MailMessageError(field, 'has an unmatched ">"');
  }
  const address = parseAddrSpec(value.slice(open + 1, -1).trim(), field);
  const display = value.slice(0, open).trim();
  if (display === '') {
    return { address };
  }
  return { name: parseDisplayName(display, field), address };
}

/** A list: an array, one address, or nothing. Each string is still a single address. */
export function parseAddressList(
  input: MailAddressInput | readonly MailAddressInput[] | undefined | null,
  field: string,
): MailAddress[] {
  if (input === undefined || input === null) {
    return [];
  }
  if (Array.isArray(input)) {
    return input.map((item, i) => parseAddress(item, `${field}[${i}]`));
  }
  return [parseAddress(input as MailAddressInput, field)];
}

/** The `<` that opens the angle-addr: the last one outside a quoted display name. */
function findAngleOpen(value: string): number {
  let quoted = false;
  let open = -1;

  for (let i = 0; i < value.length - 1; i++) {
    const c = value[i];
    if (c === '\\' && quoted) {
      i++;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
    } else if (c === '<' && !quoted) {
      open = i;
    }
  }

  return quoted ? -1 : open;
}

function parseDisplayName(display: string, field: string): string {
  if (display.startsWith('"')) {
    let name = '';
    let i = 1;
    for (; i < display.length; i++) {
      const c = display[i];
      if (c === '\\') {
        if (i + 1 >= display.length) {
          break;
        }
        name += display[++i];
      } else if (c === '"') {
        break;
      } else {
        name += c;
      }
    }

    if (i !== display.length - 1) {
      throw new MailMessageError(field, 'has text after the quoted display name, or an unterminated quote');
    }
    return checkName(name, field);
  }

  if (PHRASE_SPECIALS.test(display)) {
    throw new MailMessageError(
      field,
      'has a display name with special characters (such as a comma). Quote it ("Doe, Jane" <jane@example.com>) ' +
        'or pass { name, address }',
    );
  }
  return checkName(display.replace(/\s+/g, ' '), field);
}

function checkName(name: string, field: string): string {
  if (CONTROL.test(name)) {
    throw new MailMessageError(field, 'contains a line break or another control character');
  }
  if (name.length > 256) {
    throw new MailMessageError(field, 'is longer than 256 characters');
  }
  return name.trim();
}

/**
 * `local@domain`. The local part is a dot-atom (quoted local parts are refused; almost
 * no provider accepts them); non-ASCII is allowed there (SMTPUTF8). The domain is a
 * hostname, converted to ASCII (IDNA) so it works with every server.
 */
function parseAddrSpec(spec: string, field: string): string {
  if (CONTROL.test(spec)) {
    throw new MailMessageError(field, 'contains a line break or another control character');
  }

  const at = spec.lastIndexOf('@');
  if (at <= 0 || at === spec.length - 1) {
    throw new MailMessageError(field, `is not an email address: ${JSON.stringify(clip(spec))}`);
  }

  const local = spec.slice(0, at);
  const domain = spec.slice(at + 1);
  if (!local.split('.').every((atom) => atom !== '' && ATEXT.test(atom))) {
    throw new MailMessageError(field, `has an invalid local part: ${JSON.stringify(clip(spec))}`);
  }
  if (Buffer.byteLength(local) > 64) {
    throw new MailMessageError(field, 'has a local part longer than 64 bytes');
  }

  const ascii = toAsciiDomain(domain);
  if (!ascii) {
    throw new MailMessageError(field, `has an invalid domain: ${JSON.stringify(clip(spec))}`);
  }

  const address = `${local}@${ascii}`;
  if (Buffer.byteLength(address) > 254) {
    throw new MailMessageError(field, 'is longer than 254 bytes');
  }
  return address;
}

function toAsciiDomain(domain: string): string | undefined {
  if (domain.startsWith('[')) {
    return undefined; // address literals: not for application mail
  }

  // oxlint-disable-next-line no-control-regex -- an ASCII range check
  const ascii = /^[\x00-\x7f]*$/.test(domain) ? domain.toLowerCase() : domainToASCII(domain);
  if (!ascii || ascii.length > 253) {
    return undefined;
  }
  const labels = ascii.split('.');
  if (labels.length < 2 && ascii !== 'localhost') {
    return undefined;
  }
  return labels.every((label) => LABEL.test(label)) ? ascii : undefined;
}

/** True when the local part needs SMTPUTF8 (RFC 6531) to cross an SMTP server. */
export function isInternationalized(address: string): boolean {
  // oxlint-disable-next-line no-control-regex -- an ASCII range check
  return /[^\x00-\x7f]/.test(address);
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
