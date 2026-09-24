import type { Duration } from './duration.interface.js';

/** Options every HTTP provider transport takes. */
export interface HttpProviderOptions {
  /** Per request. Default `'30s'`. */
  timeout?: Duration;
  /** Replaces the global `fetch`, e.g. with a stub in tests. */
  fetch?: typeof globalThis.fetch;
}

export interface ResendTransportOptions extends HttpProviderOptions {
  /** A Resend API key, `re_...`. */
  apiKey: string;
  /** Default `https://api.resend.com`. */
  baseUrl?: string;
}

export interface PostmarkTransportOptions extends HttpProviderOptions {
  /** A server API token (`X-Postmark-Server-Token`). */
  serverToken: string;
  /** Default `'outbound'`, Postmark's transactional stream. */
  messageStream?: string;
  /** Default `https://api.postmarkapp.com`. */
  baseUrl?: string;
}

export interface SendGridTransportOptions extends HttpProviderOptions {
  apiKey: string;
  /** Default `https://api.sendgrid.com`; `https://api.eu.sendgrid.com` for EU subusers. */
  baseUrl?: string;
}

export interface SesTransportOptions extends HttpProviderOptions {
  /** Default: `AWS_REGION`, then `AWS_DEFAULT_REGION`. Required in one of the three. */
  region?: string;
  /**
   * Static credentials, or a function that resolves them (called for every send, so it
   * can refresh). The AWS SDK's providers fit: `credentials: fromNodeProviderChain()`
   * from `@aws-sdk/credential-providers` covers instance roles, ECS, SSO and profiles.
   * Default: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`.
   */
  credentials?: AwsCredentials | (() => AwsCredentials | Promise<AwsCredentials>);
  /** Sent as `ConfigurationSetName`, for event publishing and dedicated IPs. */
  configurationSetName?: string;
  /** Default `https://email.<region>.amazonaws.com`. */
  endpoint?: string;
}

/** AWS credentials, the shape the AWS SDK's credential providers resolve to. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
