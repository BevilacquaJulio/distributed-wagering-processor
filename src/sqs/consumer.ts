import { randomInt } from 'node:crypto';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, type Message, ReceiveMessageCommand, SendMessageCommand,
  type SQSClient } from '@aws-sdk/client-sqs';
import { ZodError } from 'zod';
import { ApplicationError, type ApplicationErrorCode } from '../application/errors';
import type { PayloadHasher, TransactionResult } from '../application/ports';
import type { WageringService } from '../application/wagering-service';
import { wagerMessageSchema, wagerSchema } from '../contracts/requests';
import { DomainError, InvalidMoneyError } from '../domain/errors';
import type { WagerCommand } from '../domain/wager-transaction';
import { logEvent, type Metrics } from '../infrastructure/observability';

export interface ConsumerSettings {
  readonly consumerName: string;
  readonly queueUrl: string;
  readonly deadLetterQueueUrl: string;
  readonly waitTimeSeconds: number;
  readonly maxMessages: number;
  readonly retryBaseSeconds: number;
  readonly retryMaxSeconds: number;
}

export const DEFAULT_CONSUMER_SETTINGS = { waitTimeSeconds: 20, maxMessages: 10, retryBaseSeconds: 2, retryMaxSeconds: 60 } as const;

/** Pontos de observação para os testes; a aplicação não registra hooks. */
export interface ConsumerHooks {
  beforeHandle?(message: Message): Promise<void>;
  afterCommit?(message: Message, result: TransactionResult): Promise<void>;
}

export type Outcome = 'processed' | 'duplicate' | 'retry' | 'dead_letter';

// Conflitos e wallet inexistente não mudam com nova tentativa; vão para a DLQ com o motivo.
const PERMANENT_CODES: ReadonlySet<ApplicationErrorCode> = new Set(['IDEMPOTENCY_CONFLICT', 'EXTERNAL_ID_CONFLICT', 'INBOX_CONFLICT', 'WALLET_NOT_FOUND']);

const RESULT_METRIC = { PROCESSED: 'processed', PENDING_REFERENCE: 'pending_reference', REJECTED: 'rejected' } as const;

type Parsed =
  | { readonly ok: true; readonly messageId: string; readonly command: WagerCommand; readonly idempotencyKey: string; readonly payloadHash: string }
  | { readonly ok: false; readonly reason: string };

function permanentReason(error: unknown): string | undefined {
  if (error instanceof ApplicationError) return PERMANENT_CODES.has(error.code) ? error.code : undefined;
  if (error instanceof ZodError || error instanceof InvalidMoneyError) return 'INVALID_PAYLOAD';
  return error instanceof DomainError ? error.code : undefined;
}

export class SqsConsumer {
  private stopping = false;
  private poll: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly wagering: WageringService,
    private readonly hasher: PayloadHasher,
    private readonly settings: ConsumerSettings,
    private readonly metrics: Metrics,
    private readonly hooks: ConsumerHooks = {},
  ) {}

  start(): Promise<void> {
    this.running ??= this.loop();
    return this.running;
  }

  /** Para de ler, conclui a mensagem em andamento e devolve a visibilidade das que ainda não começaram. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.poll?.abort();
    await this.running;
  }

  async handle(message: Message): Promise<Outcome> {
    await this.hooks.beforeHandle?.(message);
    const parsed = this.parse(message);
    if (!parsed.ok) return this.deadLetter(message, parsed.reason);
    try {
      const result = await this.wagering.submit(parsed.command, parsed.idempotencyKey, parsed.messageId,
        { consumerName: this.settings.consumerName, messageId: parsed.messageId, payloadHash: parsed.payloadHash });
      await this.hooks.afterCommit?.(message, result);
      await this.ack(message);
      const outcome = result.idempotentReplay ? 'duplicate' : 'processed';
      this.metrics.increment(outcome === 'duplicate' ? 'message_duplicate' : 'message_processed');
      if (!result.idempotentReplay) this.metrics.increment(RESULT_METRIC[result.status]);
      logEvent('message_consumed', { messageId: parsed.messageId, transactionId: result.transactionId, walletId: parsed.command.walletId,
        providerId: parsed.command.providerId, status: result.status, outcome, receiveCount: this.receiveCount(message) });
      return outcome;
    } catch (error) {
      const reason = permanentReason(error);
      return reason ? this.deadLetter(message, reason, parsed.messageId) : this.retry(message, parsed.messageId);
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let messages: Message[];
      try {
        messages = await this.receive();
      } catch (error) {
        if (this.stopping) break;
        logEvent('message_receive_failed', { error: error instanceof Error ? error.name : 'unknown' });
        await Bun.sleep(1000);
        continue;
      }
      for (const [index, message] of messages.entries()) {
        if (this.stopping) {
          await this.release(messages.slice(index));
          break;
        }
        // Sequencial de propósito: em FIFO, mensagens do mesmo grupo (wallet) precisam ser processadas em ordem.
        await this.handle(message);
      }
    }
  }

  private async receive(): Promise<Message[]> {
    this.poll = new AbortController();
    const response = await this.sqs.send(new ReceiveMessageCommand({
      QueueUrl: this.settings.queueUrl, MaxNumberOfMessages: this.settings.maxMessages, WaitTimeSeconds: this.settings.waitTimeSeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }), { abortSignal: this.poll.signal });
    return response.Messages ?? [];
  }

  private parse(message: Message): Parsed {
    try {
      const envelope = wagerMessageSchema.parse(JSON.parse(message.Body ?? ''));
      const { idempotencyKey, ...data } = envelope.data;
      return { ok: true, messageId: envelope.messageId, command: wagerSchema.parse(data), idempotencyKey,
        payloadHash: this.hasher.hash({ type: envelope.type, data: envelope.data }) };
    } catch {
      return { ok: false, reason: 'INVALID_ENVELOPE' };
    }
  }

  // Sem ack: a mensagem volta após o backoff; o redrive do broker leva à DLQ quando excede maxReceiveCount.
  private async retry(message: Message, messageId: string): Promise<Outcome> {
    const attempt = this.receiveCount(message);
    const backoff = Math.min(this.settings.retryMaxSeconds, this.settings.retryBaseSeconds * 2 ** (attempt - 1));
    const visibility = backoff + randomInt(0, this.settings.retryBaseSeconds);
    this.metrics.increment('message_retry');
    logEvent('message_retry_scheduled', { messageId, receiveCount: attempt, visibilitySeconds: visibility });
    try {
      await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.settings.queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: visibility }));
    } catch {
      logEvent('message_visibility_failed', { messageId });
    }
    return 'retry';
  }

  // O original só é apagado depois que a DLQ confirmou o recebimento; falha no envio mantém a mensagem na fila.
  private async deadLetter(message: Message, reason: string, messageId = message.MessageId ?? 'unknown'): Promise<Outcome> {
    try {
      await this.sqs.send(new SendMessageCommand({
        QueueUrl: this.settings.deadLetterQueueUrl, MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter', MessageDeduplicationId: message.MessageId,
        MessageAttributes: { failureReason: { DataType: 'String', StringValue: reason } },
      }));
    } catch {
      logEvent('message_dead_letter_failed', { messageId, reason });
      return 'retry';
    }
    await this.ack(message);
    this.metrics.increment('message_dead_letter');
    logEvent('message_dead_lettered', { messageId, reason, receiveCount: this.receiveCount(message) });
    return 'dead_letter';
  }

  private async ack(message: Message): Promise<void> {
    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.settings.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch {
      // O efeito já foi confirmado; a reentrega será reconhecida pela inbox.
      logEvent('message_ack_failed', { messageId: message.MessageId ?? 'unknown' });
    }
  }

  private async release(messages: Message[]): Promise<void> {
    await Promise.all(messages.map(async (message) => {
      try {
        await this.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.settings.queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }));
      } catch {
        logEvent('message_release_failed', { messageId: message.MessageId ?? 'unknown' });
      }
    }));
  }

  private receiveCount(message: Message): number {
    return Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
  }
}
