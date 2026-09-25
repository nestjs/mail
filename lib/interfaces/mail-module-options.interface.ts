import type { ConfigurableModuleAsyncOptions, ModuleMetadata, Type } from '@nestjs/common';
import type { MailTransport } from '../transports/mail.transport.js';
import type { MailAddressInput } from './mail-message.interface.js';
import type { MailRetryOptions } from './mail-retry-options.interface.js';

/**
 * The module's options: what `forRoot()` takes next to `transport`, and what a
 * `forRootAsync()` factory returns.
 */
export interface MailModuleOptions {
  /**
   * A transport instance. A class (Nest instantiates it) goes at the top level of
   * `forRoot()`/`forRootAsync()`; the async factory may return an instance built from
   * configuration. Required in one of the two places.
   */
  transport?: MailTransport;
  /** The default sender: `'Orders <orders@example.com>'`. */
  from?: MailAddressInput;
  /** The default Reply-To. */
  replyTo?: MailAddressInput | MailAddressInput[];
  /** Headers added to every message (a message's own headers win). */
  headers?: Record<string, string>;
  /** Default 3 attempts, 1s doubling to 30s with full jitter; `false` for one attempt. */
  retry?: number | false | MailRetryOptions;
}

/**
 * The top level of both `forRoot()` and `forRootAsync()`. A transport class (Nest
 * instantiates it, so it can inject configuration or a client) goes only here, never in
 * the async factory's result, because providers must be known when the module is defined.
 */
export interface MailModuleStructure {
  /** A `MailTransport` class or instance. Required here or in the async factory's result. */
  transport?: Type<MailTransport> | MailTransport;
  /** Modules whose exports a transport class injects (`forRootAsync()` has its own `imports`). */
  imports?: ModuleMetadata['imports'];
  /** Default `true`. */
  isGlobal?: boolean;
}

/** What `forRoot()` takes. */
export type MailModuleRootOptions = Omit<MailModuleOptions, 'transport'> & MailModuleStructure;

/** Implemented by a class passed to `forRootAsync({ useClass })`. */
export interface MailOptionsFactory {
  createMailOptions(): MailModuleOptions | Promise<MailModuleOptions>;
}

/** What `forRootAsync()` takes: `transport`, `imports` and `isGlobal` next to `useFactory`, `useClass` or `useExisting`. */
export type MailModuleAsyncOptions = ConfigurableModuleAsyncOptions<MailModuleOptions, 'createMailOptions'> &
  MailModuleStructure;
