import { randomInt } from 'node:crypto';
import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { ClaimedEvent, Clock, IdGenerator, OutboxStore } from '../application/ports';
import { logEvent, type Metrics } from '../infrastructure/observability';

export interface PublisherSettings {
  readonly queueUrl: string;
  /** Limite do SendMessageBatch. */
  readonly batchSize: number;
  readonly leaseSeconds: number;
  /** Menor que a lease: em operação normal o envio termina antes que outro publisher possa reivindicar o evento. */
  readonly sendTimeoutMs: number;
  readonly idleDelayMs: number;
  readonly retryBaseSeconds: number;
  readonly retryMaxSeconds: number;
  /** A partir daqui a falha vira alerta; o evento continua pendente e nunca é descartado. */
  readonly stalledAttempts: number;
}

export const DEFAULT_PUBLISHER_SETTINGS = {
  batchSize: 10, leaseSeconds: 30, sendTimeoutMs: 10_000, idleDelayMs: 500, retryBaseSeconds: 1, retryMaxSeconds: 300, stalledAttempts: 10,
} as const;

/** Pontos de observação para os testes; a aplicação não registra hooks. */
export interface PublisherHooks {
  beforeSend?(events: readonly ClaimedEvent[]): Promise<void>;
  afterSend?(events: readonly ClaimedEvent[]): Promise<void>;
}

export interface PublishReport {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
  readonly ownershipLost: number;
}

export function retryDelaySeconds(attempts: number, baseSeconds: number, maxSeconds: number): number {
  return Math.min(maxSeconds, baseSeconds * 2 ** Math.max(0, attempts - 1));
}

const addSeconds = (iso: string, seconds: number): string => new Date(Date.parse(iso) + seconds * 1000).toISOString();

export class OutboxPublisher {
  private stopping = false;
  private running: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly store: OutboxStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly settings: PublisherSettings,
    private readonly metrics: Metrics,
    private readonly hooks: PublisherHooks = {},
  ) {}

  start(): Promise<void> {
    this.running ??= this.loop();
    return this.running;
  }

  /** Termina o lote em andamento; o que já foi reivindicado é confirmado ou reagendado antes de sair. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
  }

  async publishOnce(): Promise<PublishReport> {
    const token = this.ids.next();
    const now = this.clock.now();
    const claimed = await this.store.claim(token, now, addSeconds(now, this.settings.leaseSeconds), this.settings.batchSize);
    if (claimed.length === 0) return { claimed: 0, published: 0, failed: 0, ownershipLost: 0 };

    await this.hooks.beforeSend?.(claimed);
    const failures = await this.send(claimed);
    await this.hooks.afterSend?.(claimed);

    const sent = claimed.filter((event) => !failures.has(event.envelope.eventId)).map((event) => event.envelope.eventId);
    const confirmed = new Set(await this.store.markPublished(token, sent, this.clock.now()));
    let ownershipLost = sent.length - confirmed.size;
    for (const event of claimed) {
      const error = failures.get(event.envelope.eventId);
      if (error === undefined) continue;
      if (!await this.reschedule(token, event, error)) ownershipLost += 1;
    }

    for (const event of claimed) {
      if (!confirmed.has(event.envelope.eventId)) continue;
      this.metrics.increment('event_published');
      logEvent('event_published', { eventId: event.envelope.eventId, eventType: event.envelope.eventType,
        attempts: event.attempts, lagMs: Date.parse(this.clock.now()) - Date.parse(event.envelope.occurredAt) });
    }
    for (let index = 0; index < ownershipLost; index++) this.metrics.increment('event_ownership_lost');
    if (ownershipLost > 0) logEvent('outbox_ownership_lost', { events: ownershipLost });
    return { claimed: claimed.length, published: confirmed.size, failed: failures.size, ownershipLost };
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let claimed = 0;
      try {
        claimed = (await this.publishOnce()).claimed;
      } catch (error) {
        // Banco indisponível no claim ou na confirmação: o que estiver reivindicado volta quando a lease vencer.
        logEvent('outbox_cycle_failed', { error: error instanceof Error ? error.name : 'unknown' });
      }
      if (claimed < this.settings.batchSize) await this.pause();
    }
  }

  private pause(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.settings.idleDelayMs);
      function done() { clearTimeout(timer); resolve(); }
      this.wake = done;
    });
  }

  // FIFO por wallet e deduplicação pelo eventId: reenvio no intervalo de deduplicação do SQS é descartado pelo broker,
  // depois dele o consumidor deduplica pelo mesmo eventId.
  private async send(events: readonly ClaimedEvent[]): Promise<Map<string, string>> {
    const failures = new Map<string, string>();
    try {
      const response = await this.sqs.send(new SendMessageBatchCommand({
        QueueUrl: this.settings.queueUrl,
        Entries: events.map(({ envelope }) => ({
          Id: envelope.eventId, MessageBody: JSON.stringify(envelope), MessageGroupId: envelope.aggregateId,
          MessageDeduplicationId: envelope.eventId,
          MessageAttributes: { eventType: { DataType: 'String', StringValue: envelope.eventType } },
        })),
      }), { abortSignal: AbortSignal.timeout(this.settings.sendTimeoutMs) });
      for (const failed of response.Failed ?? []) if (failed.Id) failures.set(failed.Id, failed.Code ?? 'BatchEntryFailed');
      // Entrada sem resultado é tratada como falha: reenviar é seguro, perder não.
      const succeeded = new Set((response.Successful ?? []).map((entry) => entry.Id));
      for (const { envelope } of events) {
        if (!succeeded.has(envelope.eventId) && !failures.has(envelope.eventId)) failures.set(envelope.eventId, 'MissingBatchResult');
      }
    } catch (error) {
      // Timeout pode esconder um envio aceito; o retry mantém o eventId e a duplicata continua identificável.
      const name = error instanceof Error ? error.name : 'unknown';
      for (const { envelope } of events) failures.set(envelope.eventId, name);
    }
    return failures;
  }

  private async reschedule(token: string, event: ClaimedEvent, error: string): Promise<boolean> {
    const { retryBaseSeconds, retryMaxSeconds, stalledAttempts } = this.settings;
    const delay = retryDelaySeconds(event.attempts, retryBaseSeconds, retryMaxSeconds) + randomInt(0, 1000) / 1000;
    const rescheduled = await this.store.markFailed(token, event.envelope.eventId, addSeconds(this.clock.now(), delay), error);
    this.metrics.increment('event_publish_failed');
    const fields = { eventId: event.envelope.eventId, eventType: event.envelope.eventType, attempts: event.attempts, error, retryInSeconds: delay };
    logEvent(event.attempts >= stalledAttempts ? 'outbox_event_stalled' : 'event_publish_failed', fields);
    return rescheduled;
  }
}
