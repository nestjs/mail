import type { LoggerService } from '@nestjs/common';

export interface FileMailTransportOptions {
  /** Where the `.eml` files go. Created when missing. */
  directory: string;
  /** Log each file's path (context `FileMailTransport`). Default `true`. */
  log?: boolean;
}

export interface LogMailTransportOptions {
  /** Also log the text body (at `debug` level), where links such as sign-in links show up. Default `true`. */
  body?: boolean;
  /** Default: Nest's `Logger` with the context `LogMailTransport`. */
  logger?: LoggerService;
}
