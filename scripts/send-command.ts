import { randomUUID } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { readMessagingConfig } from '../src/config';
import { wagerMessageSchema, wagerSchema } from '../src/contracts/requests';
import { createSqsClient, queueUrl } from '../src/infrastructure/sqs/client';

// Envio manual de um comando à fila, para testar a entrada SQS sem AWS CLI. O envelope passa pelos mesmos
// schemas do consumidor antes do envio, então um comando inválido falha aqui e não vai para a DLQ.
const USAGE = 'Uso: bun run sqs:send <walletId> <playerId> <BET|WIN|LOSS|REFUND|ROLLBACK> <valor> [idExternoReferenciado]';
const [walletId, playerId, kind, amount, reference] = process.argv.slice(2);
const messaging = readMessagingConfig();
const sqs = createSqsClient(messaging);
try {
  if (!walletId || !playerId || !kind || !amount) throw new Error(USAGE);
  const externalTransactionId = `${kind.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const data = wagerSchema.parse({
    providerId: 'provider-a', externalTransactionId, playerId, walletId, roundId: 'round-1', gameId: 'game-1', kind,
    money: { amount, currency: 'BRL' }, ...(reference ? { referenceExternalTransactionId: reference } : {}),
  });
  const envelope = wagerMessageSchema.parse({ messageId: randomUUID(), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: { ...data, idempotencyKey: `key-${externalTransactionId}` } });
  await sqs.send(new SendMessageCommand({ QueueUrl: await queueUrl(sqs, messaging.SQS_COMMAND_QUEUE), MessageBody: JSON.stringify(envelope),
    MessageGroupId: walletId, MessageDeduplicationId: envelope.messageId }));
  process.stdout.write(`${JSON.stringify({ queue: messaging.SQS_COMMAND_QUEUE, messageId: envelope.messageId, externalTransactionId,
    idempotencyKey: envelope.data.idempotencyKey })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error && error.message === USAGE ? USAGE : 'Comando não enviado. Confira os argumentos, a fila e o emulador.'}\n`);
  process.exitCode = 1;
} finally {
  sqs.destroy();
}
