import { MailError } from './mail.error.js';

/**
 * The connection failed: DNS, refused, reset, TLS, a certificate that doesn't verify,
 * a server that went away. Transient, except for configuration problems that can't fix
 * themselves (`permanent: true`): a server without STARTTLS when it is required, without
 * AUTH when credentials are set, without SMTPUTF8 for an internationalized address.
 * `cause` holds the underlying error, e.g. `cause.code === 'ECONNREFUSED'`.
 */
export class MailConnectionError extends MailError {}
