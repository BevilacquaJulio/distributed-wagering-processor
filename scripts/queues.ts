import { CreateQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { readMessagingConfig } from '../src/config';
import { createSqsClient, queueUrl } from '../src/infrastructure/sqs/client';

// Provisionamento manual das filas. Comandos: visibilidade de 30s para o processamento, cinco recebimentos
// antes do redrive para a DLQ e retenção de 14 dias na DLQ para auditoria. Eventos: FIFO com deduplicação
// pelo eventId enviado pelo publisher e a mesma retenção, para consumidores que fiquem parados por dias.
const VISIBILITY_SECONDS = '30';
const MAX_RECEIVE_COUNT = '5';
const RETENTION_SECONDS = '1209600';

const messaging = readMessagingConfig();
const sqs = createSqsClient(messaging);
try {
  const action = process.argv[2];
  if (action !== 'provision' && action !== 'status') throw new Error('Expected provision or status');
  if (action === 'provision') {
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: messaging.SQS_DEAD_LETTER_QUEUE,
      Attributes: { FifoQueue: 'true', MessageRetentionPeriod: RETENTION_SECONDS } }));
    const dlqArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))).Attributes?.QueueArn;
    if (!dlqArn) throw new Error('Dead-letter queue has no ARN');
    await sqs.send(new CreateQueueCommand({ QueueName: messaging.SQS_COMMAND_QUEUE, Attributes: {
      FifoQueue: 'true', VisibilityTimeout: VISIBILITY_SECONDS,
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: MAX_RECEIVE_COUNT }),
    } }));
    await sqs.send(new CreateQueueCommand({ QueueName: messaging.SQS_EVENT_QUEUE,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', MessageRetentionPeriod: RETENTION_SECONDS } }));
  }
  const queues = [messaging.SQS_COMMAND_QUEUE, messaging.SQS_DEAD_LETTER_QUEUE, messaging.SQS_EVENT_QUEUE];
  const statuses = await Promise.all(queues.map(async (name) => {
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: await queueUrl(sqs, name),
      AttributeNames: ['FifoQueue', 'VisibilityTimeout', 'RedrivePolicy', 'ApproximateNumberOfMessages'] }));
    return { queue: name, ...Attributes };
  }));
  for (const status of statuses) process.stdout.write(`${JSON.stringify(status)}\n`);
} catch {
  process.stderr.write('Operação de filas não concluída. Confira endpoint, região, credenciais e nomes das filas.\n');
  process.exitCode = 1;
} finally {
  sqs.destroy();
}
