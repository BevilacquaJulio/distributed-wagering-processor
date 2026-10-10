import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res, ServiceUnavailableException } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MessagingConfig } from '../config';
import type { Backlog, FinancialQueries } from '../application/ports';
import { WageringService } from '../application/wagering-service';
import { cursorSchema, identifier, ledgerQuerySchema, openWalletSchema, uuid, wagerSchema } from '../contracts/requests';
import { type Gauge, logEvent, Metrics, requestContext } from '../infrastructure/observability';
import { SCHEMA_VERSION } from '../infrastructure/postgres/config';
import { assertQueueReachable, queueUrl } from '../infrastructure/sqs/client';
import { InvalidRequest } from './error-filter';

export const ORM = Symbol('ORM');
// 202 é aceite com processamento pendente, não sucesso financeiro final.
const RESULT_STATUS = { PROCESSED: 200, PENDING_REFERENCE: 202, REJECTED: 422 } as const;
const RESULT_METRIC = { PROCESSED: 'processed', PENDING_REFERENCE: 'pending_reference', REJECTED: 'rejected' } as const;
export const QUERIES = Symbol('QUERIES');
export const SQS = Symbol('SQS');
export const MESSAGING = Symbol('MESSAGING');
interface HttpResponse { status(code: number): HttpResponse; json(body: unknown): void; type(value: string): HttpResponse; send(body: string): void; }

@Controller()
export class FinancialController {
  constructor(
    @Inject(WageringService) private readonly wagering: WageringService,
    @Inject(QUERIES) private readonly queries: FinancialQueries,
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  @Post('wallets')
  async open(@Body() input: unknown) {
    const command = openWalletSchema.parse(input);
    const wallet = await this.wagering.openWallet(command.playerId, command.initialBalance, this.correlationId());
    logEvent('wallet_opened', { walletId: wallet.id });
    return wallet;
  }

  @Get('wallets/:walletId')
  wallet(@Param('walletId') id: string) { return this.queries.wallet(uuid.parse(id)); }

  @Post('wagering/transactions')
  async submit(@Body() input: unknown, @Headers('idempotency-key') header: unknown, @Res() response: HttpResponse) {
    if (header === undefined || header === '') throw new InvalidRequest('MISSING_IDEMPOTENCY_KEY');
    const key = identifier.parse(header);
    const command = wagerSchema.parse(input);
    const started = performance.now();
    const result = await this.wagering.submit(command, key, this.correlationId());
    this.metrics.increment(result.idempotentReplay ? 'replay' : RESULT_METRIC[result.status]);
    logEvent('wager_result', { walletId: command.walletId, providerId: command.providerId, kind: command.kind,
      transactionId: result.transactionId, status: result.status, replay: result.idempotentReplay,
      durationMs: Math.round(performance.now() - started), failureCode: result.failureCode ?? null });
    response.status(RESULT_STATUS[result.status]).json(result);
  }

  @Get('wagering/transactions/:transactionId')
  transaction(@Param('transactionId') id: string) { return this.queries.transaction(uuid.parse(id)); }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  external(@Param('providerId') providerId: string, @Param('externalTransactionId') id: string) {
    return this.queries.transactionByExternal(identifier.parse(providerId), identifier.parse(id));
  }

  @Get('wallets/:walletId/ledger')
  async ledger(@Param('walletId') rawWalletId: string, @Query() rawQuery: unknown) {
    const walletId = uuid.parse(rawWalletId);
    const query = ledgerQuerySchema.parse(rawQuery);
    let cursor: ReturnType<typeof cursorSchema.parse> | undefined;
    if (query.cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error('Invalid cursor encoding');
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')));
        if (cursor.walletId !== walletId) throw new Error('Cursor belongs to another wallet');
      } catch { throw new InvalidRequest('INVALID_PAYLOAD'); }
    }
    const page = await this.queries.ledger(walletId, query.limit, cursor);
    return { entries: page.entries, nextCursor: page.next ? Buffer.from(JSON.stringify({ walletId, ...page.next })).toString('base64url') : null };
  }

  @Post('wallets/:walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId') id: string) {
    const result = await this.queries.reconcile(uuid.parse(id));
    if (!result.consistent) this.metrics.increment('reconciliation_divergence');
    logEvent('wallet_reconciled', { walletId: result.walletId, consistent: result.consistent, checkedEntries: result.checkedEntries });
    return result;
  }

  private correlationId(): string {
    const id = requestContext.getStore()?.correlationId;
    if (!id) throw new Error('Missing request context');
    return id;
  }
}

@Controller()
export class HealthController {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS) private readonly sqs: SQSClient,
    @Inject(MESSAGING) private readonly messaging: MessagingConfig,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(QUERIES) private readonly queries: FinancialQueries,
  ) {}

  @Get('health/live')
  live() { return { status: 'up' }; }

  @Get('health/ready')
  async ready() {
    const [postgres, sqs] = await Promise.all([this.postgresReady(), this.sqsReady()]);
    if (!postgres || !sqs) throw new ServiceUnavailableException();
    return { status: 'up', dependencies: { postgres: 'up', sqs: 'up' } };
  }

  private async postgresReady(): Promise<boolean> {
    try {
      const rows = await this.orm.em.fork().execute<{ version: number }[]>('select version from schema_version where version = ?', [SCHEMA_VERSION]);
      return rows.length > 0;
    } catch { return false; }
  }

  // A fila de comandos precisa existir e responder; a readiness não cria recursos.
  private async sqsReady(): Promise<boolean> {
    try {
      const signal = AbortSignal.timeout(2000);
      await assertQueueReachable(this.sqs, await queueUrl(this.sqs, this.messaging.SQS_COMMAND_QUEUE, signal), signal);
      return true;
    } catch { return false; }
  }

  @Get('metrics')
  async metricsEndpoint(@Res() response: HttpResponse) {
    response.type('text/plain; version=0.0.4').send(this.metrics.render(await this.backlogGauges()));
  }

  // Backlog vem do banco e vale para o sistema todo, não só para este processo; sem banco, só o indicador de falha.
  private async backlogGauges(): Promise<Gauge[]> {
    let backlog: Backlog;
    try {
      backlog = await this.queries.backlog();
    } catch {
      return [{ name: 'wagering_backlog_scrape_success', help: 'Whether the database backlog could be read.', value: 0 }];
    }
    return [
      { name: 'wagering_backlog_scrape_success', help: 'Whether the database backlog could be read.', value: 1 },
      { name: 'outbox_pending_events', help: 'Outbox events not yet published.', value: backlog.outboxPending },
      { name: 'outbox_oldest_pending_age_seconds', help: 'Age of the oldest unpublished outbox event (outbox lag).',
        value: Math.max(0, backlog.outboxOldestPendingSeconds) },
      { name: 'pending_references_open', help: 'Transactions waiting for their reference.', value: backlog.pendingReferencesOpen },
      { name: 'pending_references_oldest_age_seconds', help: 'Age of the oldest transaction waiting for its reference.',
        value: Math.max(0, backlog.pendingReferencesOldestSeconds) },
      { name: 'pending_references_overdue', help: 'Open pending references past their deadline.', value: backlog.pendingReferencesOverdue },
    ];
  }
}
