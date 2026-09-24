import { ConfigurableModuleBuilder, type Provider, type Type } from '@nestjs/common';
import type { MailModuleOptions, MailModuleStructure } from './interfaces/mail-module-options.interface.js';
import { MailTransport } from './transports/mail.transport.js';

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN: MAIL_MODULE_OPTIONS,
  OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<MailModuleOptions>({ moduleName: 'Mail' })
  .setClassMethodName('forRoot')
  .setFactoryMethodName('createMailOptions')
  .setExtras<MailModuleStructure>(
    { isGlobal: true, transport: undefined, imports: undefined },
    (definition, { isGlobal, transport, imports }) => ({
      ...definition,
      global: isGlobal,
      imports: [...new Set([...(definition.imports ?? []), ...(imports ?? [])])],
      providers: [...(definition.providers ?? []), transportProvider(transport)],
    }),
  )
  .build();

export function missingTransportError(): Error {
  return new Error(
    'MailModule needs a `transport`: new SmtpTransport({ host, auth }), a provider such as ' +
      "new ResendTransport({ apiKey }), or new FileMailTransport({ directory: 'mail' }) in development. " +
      'Pass it to forRoot(), next to useFactory in forRootAsync(), or return an instance from the factory.',
  );
}

/**
 * The top-level transport (a class Nest creates, or an instance), else the instance the
 * async factory returned. A class returned by the factory, a transport set in both
 * places, or none at all fails at startup.
 */
function transportProvider(transport: MailModuleStructure['transport']): Provider {
  if (transport !== undefined) {
    if (typeof transport === 'function') {
      return {
        provide: MailTransport,
        useClass: transport,
      };
    }
    assertInstance(transport, 'forRoot()');
  }

  return {
    provide: MailTransport,
    inject: [MAIL_MODULE_OPTIONS],
    useFactory: (options: MailModuleOptions | undefined) => {
      const fromFactory = options?.transport;
      if (fromFactory !== undefined && transport !== undefined && fromFactory !== transport) {
        throw new Error(
          'MailModule: `transport` is set both at the top level of forRootAsync() and in the options ' +
            'its factory returns. Set it in one place.',
        );
      }

      const resolved = transport ?? fromFactory;
      if (resolved === undefined) {
        throw missingTransportError();
      }
      if (typeof resolved === 'function') {
        throw new Error(
          `MailModule: the forRootAsync() factory returned a class as \`transport\` (${(resolved as Type).name}). ` +
            'Classes go at the top level of forRootAsync(), next to useFactory, where Nest instantiates them; ' +
            'the factory returns instances.',
        );
      }
      assertInstance(resolved, 'the forRootAsync() factory');
      return resolved;
    },
  };
}

function assertInstance(value: unknown, where: string): void {
  if (!value || typeof value !== 'object' || typeof (value as MailTransport).send !== 'function') {
    throw new TypeError(`MailModule: \`transport\` from ${where} must be a MailTransport class or instance`);
  }
}
