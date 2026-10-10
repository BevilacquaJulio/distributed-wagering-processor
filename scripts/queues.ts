import { CreateQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { readMessagingConfig } from '../src/config';
import { createSqsClient, queueUrl } from '../src/infrastructure/sqs/client';

// Provisionamento manual das filas de comandos. Atributos: visibilidade de 30s para o processamento,
// cinco recebimentos antes do redrive para a DLQ e retenção de 14 dias na DLQ para auditoria.
const VISIBILITY_SECONDS = '30';
const MAX_RECEIVE_COUNT = '5';
const DLQ_RETENTION_SECONDS = '1209600';

const messaging = readMessagingConfig();
const sqs = createSqsClient(messaging);
try {
  const action = process.argv[2];
  if (action !== 'provision' && action !== 'status') throw new Error('Expected provision or status');
  if (action === 'provision') {
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: messaging.SQS_DEAD_LETTER_QUEUE,
      Attributes: { FifoQueue: 'true', MessageRetentionPeriod: DLQ_RETENTION_SECONDS } }));
    const dlqArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))).Attributes?.QueueArn;
    if (!dlqArn) throw new Error('Dead-letter queue has no ARN');
    await sqs.send(new CreateQueueCommand({ QueueName: messaging.SQS_COMMAND_QUEUE, Attributes: {
      FifoQueue: 'true', VisibilityTimeout: VISIBILITY_SECONDS,
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: MAX_RECEIVE_COUNT }),
    } }));
  }
  for (const name of [messaging.SQS_COMMAND_QUEUE, messaging.SQS_DEAD_LETTER_QUEUE]) {
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: await queueUrl(sqs, name),
      AttributeNames: ['FifoQueue', 'VisibilityTimeout', 'RedrivePolicy', 'ApproximateNumberOfMessages'] }));
    process.stdout.write(`${JSON.stringify({ queue: name, ...Attributes })}\n`);
  }
} catch {
  process.stderr.write('Operação de filas não concluída. Confira endpoint, região, credenciais e nomes das filas.\n');
  process.exitCode = 1;
} finally {
  sqs.destroy();
}
