import { channel, type Channel } from 'node:diagnostics_channel';
import type { MailEvent } from './mail-events.interface.js';

/** The `node:diagnostics_channel` channel of each event type. */
export const channels: Record<MailEvent['type'], Channel> = {
  sent: channel('nestjs:mail:sent'),
  failed: channel('nestjs:mail:failed'),
};
