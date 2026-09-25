// Module and options
export { MailModule } from './mail.module.js';
export { MAIL_MODULE_OPTIONS } from './mail.module-definition.js';
export type {
  Duration,
  MailBackoffOptions,
  MailModuleAsyncOptions,
  MailModuleOptions,
  MailOptionsFactory,
  MailRetryOptions,
} from './interfaces/index.js';

// Sending: the mailer, mail classes, and what they take and return
export { Mailer } from './mailer.service.js';
export type {
  Mailable,
  MailableRenderOptions,
  MailableSendOptions,
  MailAddress,
  MailAddressInput,
  MailAttachment,
  MailAttachmentInput,
  MailContent,
  MailDeliveryOptions,
  MailRenderContext,
  MailRenderOptions,
  MailSendOptions,
  MailSendResult,
  MailTemplateContent,
} from './interfaces/index.js';
export { MailMessage } from './message/mail-message.js';

// Writing HTML: auto-escaping template, explicit opt-out
export { html, unsafeHtml, type SafeHtml } from './message/html.util.js';

// Templates: the built-in engine over template files, and the contract for your own
export { FileTemplateEngine, MailTemplateEngine } from './templates/index.js';
export type {
  FileTemplateEngineOptions,
  MailTemplateOutput,
  MailTemplateRenderOptions,
} from './interfaces/index.js';

// Transports
export { MailTransport } from './transports/mail.transport.js';
export { SmtpTransport } from './smtp/smtp.transport.js';
export { ResendTransport } from './transports/resend.transport.js';
export { PostmarkTransport } from './transports/postmark.transport.js';
export { SendGridTransport } from './transports/sendgrid.transport.js';
export { SesTransport } from './transports/ses.transport.js';
export { FileMailTransport } from './transports/file.transport.js';
export { LogMailTransport } from './transports/log.transport.js';
export type {
  AwsCredentials,
  DkimOptions,
  FileMailTransportOptions,
  LogMailTransportOptions,
  MailTransportResult,
  MailTransportSendOptions,
  PostmarkTransportOptions,
  ResendTransportOptions,
  SendGridTransportOptions,
  SesTransportOptions,
  SmtpPoolOptions,
  SmtpTransportOptions,
} from './interfaces/index.js';

// Testing
export { InMemoryMailTransport } from './transports/in-memory.transport.js';
export { SentMail } from './transports/sent-mail.js';
export type { SentMailQuery } from './interfaces/index.js';

// Events
export { MailEvents } from './events/index.js';
export type { MailEvent, MailFailedEvent, MailSentEvent } from './events/index.js';

// Errors
export * from './errors/index.js';
