import { randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, type Message, ReceiveMessageCommand, SendMessageCommand,
  type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createWageringService } from '../../src/bootstrap';
import { readMessagingConfig } from '../../src/config';
import type { WagerCommand } from '../../src/domain/wager-transaction';
import { Sha256PayloadHasher } from '../../src/infrastructure/identity';
import { Metrics } from '../../src/infrastructure/observability';
import { createSqsClient } from '../../src/infrastructure/sqs/client';
import { type ConsumerHooks, type ConsumerSettings, SqsConsumer } from '../../src/sqs/consumer';

export interface TestQueues {
  readonly url: string;
  readonly deadLetterUrl: string;
  remove(): Promise<void>;
}

export const testSqs = (): SQSClient => createSqsClient(readMessagingConfig());

// Filas exclusivas por suíte: visibilidade curta e poucos recebimentos tornam retry e redrive observáveis em segundos.
export async function createTestQueues(sqs: SQSClient, visibilitySeconds = 2, maxReceiveCount = 3): Promise<TestQueues> {
  const name = `test-${randomUUID().slice(0, 8)}`;
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `${name}-dlq.fifo`, Attributes: { FifoQueue: 'true' } }));
  const arn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))).Attributes?.QueueArn;
  const main = await sqs.send(new CreateQueueCommand({ QueueName: `${name}.fifo`, Attributes: {
    FifoQueue: 'true', VisibilityTimeout: String(visibilitySeconds),
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: String(maxReceiveCount) }),
  } }));
  if (!main.QueueUrl || !dlq.QueueUrl) throw new Error('Test queues were not created');
  const url = main.QueueUrl;
  const deadLetterUrl = dlq.QueueUrl;
  return {
    url, deadLetterUrl,
    remove: async () => {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: deadLetterUrl }));
    },
  };
}

export function envelope(command: WagerCommand, idempotencyKey: string, messageId = randomUUID()): string {
  return JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: { ...command, idempotencyKey } });
}

// Grupo por wallet, como um provedor faria; cada envio tem deduplicação própria para permitir redelivery deliberado.
export async function sendBody(sqs: SQSClient, url: string, body: string, group = 'wallet'): Promise<void> {
  await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageGroupId: group, MessageDeduplicationId: randomUUID() }));
}

export async function receive(sqs: SQSClient, url: string, waitSeconds = 5): Promise<Message[]> {
  const response = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: waitSeconds,
    MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'], MessageAttributeNames: ['All'] }));
  return response.Messages ?? [];
}

export async function receiveOne(sqs: SQSClient, url: string, waitSeconds = 5): Promise<Message> {
  const [message] = await receive(sqs, url, waitSeconds);
  if (!message) throw new Error(`No message received within ${waitSeconds}s`);
  return message;
}

export async function queueDepth(sqs: SQSClient, url: string): Promise<{ visible: number; inFlight: number }> {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
  return { visible: Number(Attributes?.ApproximateNumberOfMessages ?? 0), inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) };
}

export function testConsumer(sqs: SQSClient, orm: MikroORM, queues: TestQueues, hooks: ConsumerHooks = {},
  overrides: Partial<ConsumerSettings> = {}): SqsConsumer {
  return new SqsConsumer(sqs, createWageringService(orm), new Sha256PayloadHasher(), {
    consumerName: 'test-consumer', queueUrl: queues.url, deadLetterQueueUrl: queues.deadLetterUrl,
    waitTimeSeconds: 1, maxMessages: 10, retryBaseSeconds: 1, retryMaxSeconds: 2, ...overrides,
  }, new Metrics(), hooks);
}
