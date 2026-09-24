import {
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { MailEvents } from './events/mail-events.service.js';
import { LOCAL_TRANSPORT } from './mail.constants.js';
import { MailTransport } from './transports/mail.transport.js';
import {
  ConfigurableModuleClass,
  MAIL_MODULE_OPTIONS,
  missingTransportError,
  type OPTIONS_TYPE,
} from './mail.module-definition.js';
import type { MailModuleAsyncOptions, MailModuleRootOptions } from './interfaces/mail-module-options.interface.js';
import { Mailer } from './mailer.service.js';

/**
 * `MailModule.forRoot({ transport, from, replyTo, headers, retry })`, or
 * `forRootAsync({ transport?, imports, inject, useFactory })` where the factory returns
 * the options, and may return the transport as an instance built from configuration.
 * Global by default. Provides `Mailer`, `MailEvents` and `MailTransport`.
 *
 * On shutdown, it waits for the sends in flight, then closes the transport (an SMTP
 * pool says QUIT) and completes `MailEvents.events$`.
 */
@Module({
  providers: [Mailer, MailEvents],
  exports: [Mailer, MailEvents, MailTransport, MAIL_MODULE_OPTIONS],
})
export class MailModule extends ConfigurableModuleClass implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly mailer: Mailer,
    private readonly transport: MailTransport,
    private readonly events: MailEvents,
  ) {
    super();
  }

  static forRoot(options: MailModuleRootOptions): DynamicModule {
    if (options?.transport === undefined) {
      throw missingTransportError();
    }
    return super.forRoot(options as typeof OPTIONS_TYPE);
  }

  static forRootAsync(options: MailModuleAsyncOptions): DynamicModule {
    return super.forRootAsync(options);
  }

  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'production' && (this.transport as { [LOCAL_TRANSPORT]?: boolean })[LOCAL_TRANSPORT]) {
      new Logger('MailModule').warn(
        `The mail transport is ${this.transport.constructor.name}, which doesn't deliver mail, and ` +
          'NODE_ENV is "production". Configure SmtpTransport or a provider transport.',
      );
    }
  }

  // Runs after every module's onModuleDestroy(), where an outbox relay finishes the
  // handlers that are still sending, and after the MailEvents provider's own hooks.
  async onApplicationShutdown() {
    await this.mailer.drain?.(); // absent when a test replaced the Mailer
    await this.transport.close?.();
    this.events.complete();
  }
}
