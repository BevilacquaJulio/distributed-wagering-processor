import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { MessagingConfig } from '../../config';

// Credenciais seguem a cadeia padrão do SDK (variáveis AWS_*); nada é lido ou registrado aqui.
export function createSqsClient(config: MessagingConfig): SQSClient {
  return new SQSClient({ region: config.SQS_REGION, ...(config.SQS_ENDPOINT ? { endpoint: config.SQS_ENDPOINT } : {}), maxAttempts: 3 });
}

export async function queueUrl(sqs: SQSClient, name: string, signal?: AbortSignal): Promise<string> {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }), signal ? { abortSignal: signal } : {});
  if (!QueueUrl) throw new Error(`Queue ${name} has no URL`);
  return QueueUrl;
}

export async function assertQueueReachable(sqs: SQSClient, url: string, signal?: AbortSignal): Promise<void> {
  await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }), signal ? { abortSignal: signal } : {});
}

export async function queueDepth(sqs: SQSClient, url: string, signal?: AbortSignal): Promise<number> {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }),
    signal ? { abortSignal: signal } : {});
  return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
}
