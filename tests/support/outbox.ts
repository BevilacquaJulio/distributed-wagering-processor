import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, type Message, ReceiveMessageCommand,
  type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Clock } from '../../src/application/ports';
import type { EventEnvelope } from '../../src/domain/events';
import { UuidGenerator } from '../../src/infrastructure/identity';
import { Metrics } from '../../src/infrastructure/observability';
import { PostgresOutboxStore } from '../../src/infrastructure/postgres/outbox';
import { DEFAULT_PUBLISHER_SETTINGS, OutboxPublisher, type PublisherHooks, type PublisherSettings,
  type PublishReport } from '../../src/sqs/publisher';

/** Relógio deslocado: simula o vencimento da lease ou do backoff sem esperar o tempo real. */
export class ShiftedClock implements Clock {
  constructor(private readonly offsetSeconds = 0) {}
  now(): string { return new Date(Date.now() + this.offsetSeconds * 1000).toISOString(); }
}

export interface EventQueue {
  readonly url: string;
  remove(): Promise<void>;
}

export async function createEventQueue(sqs: SQSClient): Promise<EventQueue> {
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: `test-events-${randomUUID().slice(0, 8)}.fifo`,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }));
  if (!QueueUrl) throw new Error('Event queue was not created');
  return { url: QueueUrl, remove: async () => { await sqs.send(new DeleteQueueCommand({ QueueUrl })); } };
}

export interface TestPublisher {
  readonly publisher: OutboxPublisher;
  readonly metrics: Metrics;
}

export function testPublisher(sqs: SQSClient, orm: MikroORM, queueUrl: string, options: {
  clock?: Clock; hooks?: PublisherHooks; settings?: Partial<PublisherSettings>;
} = {}): TestPublisher {
  const metrics = new Metrics();
  const publisher = new OutboxPublisher(sqs, new PostgresOutboxStore(orm), options.clock ?? new ShiftedClock(), new UuidGenerator(), {
    ...DEFAULT_PUBLISHER_SETTINGS, idleDelayMs: 50, sendTimeoutMs: 5000, queueUrl, ...options.settings,
  }, metrics, options.hooks);
  return { publisher, metrics };
}

/** Publica até não haver evento elegível para este relógio. */
export async function drain(publisher: OutboxPublisher): Promise<PublishReport> {
  const total = { claimed: 0, published: 0, failed: 0, ownershipLost: 0 };
  for (let report = await publisher.publishOnce(); report.claimed > 0; report = await publisher.publishOnce()) {
    total.claimed += report.claimed;
    total.published += report.published;
    total.failed += report.failed;
    total.ownershipLost += report.ownershipLost;
  }
  return total;
}

export interface ReceivedEvent {
  readonly envelope: EventEnvelope;
  readonly message: Message;
}

// Em FIFO o grupo fica bloqueado enquanto há mensagem em voo: apagar cada lote libera o seguinte.
export async function collect(sqs: SQSClient, url: string): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
  for (;;) {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'], MessageAttributeNames: ['All'] }));
    if (Messages.length === 0) return received;
    for (const message of Messages) {
      received.push({ envelope: JSON.parse(message.Body ?? '') as EventEnvelope, message });
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
    }
  }
}

export interface OutboxState {
  readonly id: string;
  readonly eventType: string;
  readonly attempts: number;
  readonly claimed: boolean;
  readonly publishedAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
}

export function outboxState(orm: MikroORM, walletIds: readonly string[]): Promise<OutboxState[]> {
  return orm.em.fork().execute<OutboxState[]>(`
    select id, event_type as "eventType", attempts, claim_token is not null as claimed,
      to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "publishedAt",
      to_char(next_attempt_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "nextAttemptAt",
      last_error as "lastError"
    from outbox_messages where aggregate_id in (${walletIds.map(() => '?').join(', ')}) order by position`, [...walletIds]);
}
