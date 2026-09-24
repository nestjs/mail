import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import type { MailEvent } from './mail-events.interface.js';
import { channels } from './mail.channels.js';

/**
 * What the mailer sent and what failed, for metrics, alerting and an audit trail. Every
 * event is also published on its `node:diagnostics_channel` channel
 * (`nestjs:mail:sent`, `nestjs:mail:failed`), where instrumentation can subscribe
 * without depending on Nest. `events$` completes on application shutdown, after the
 * sends still in flight have finished.
 */
@Injectable()
export class MailEvents {
  private readonly subject = new Subject<MailEvent>();
  readonly events$: Observable<MailEvent> = this.subject.asObservable();

  /** @internal Called by the mailer. */
  emit(event: MailEvent): void {
    const target = channels[event.type];
    if (target.hasSubscribers) {
      target.publish(event);
    }
    this.subject.next(event);
  }

  /** @internal Called by `MailModule` in `onApplicationShutdown`, once the mailer has drained. */
  complete(): void {
    this.subject.complete();
  }
}
