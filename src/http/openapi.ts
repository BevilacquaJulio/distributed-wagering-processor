import { z } from 'zod';
import { identifier, moneySchema, openWalletSchema, uuid, wagerSchema } from '../contracts/requests';

// Requisições usam os mesmos schemas Zod que validam a API: a documentação não diverge do contrato aplicado.
// Respostas são descritas aqui a partir dos tipos de saída; servem só à documentação.
// Documento OpenAPI 3.1 (JSON Schema 2020-12); os tipos do @nestjs/swagger cobrem só o 3.0.
export type OpenApiDocument = Readonly<Record<string, unknown>>;
const timestamp = z.iso.datetime();
const failureCode = z.enum(['INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'CURRENCY_MISMATCH', 'CURRENCY_NOT_SUPPORTED',
  'WALLET_PLAYER_MISMATCH', 'AMOUNT_NOT_ALLOWED', 'BALANCE_LIMIT_EXCEEDED', 'INVALID_REFERENCE', 'REFERENCE_NOT_PROCESSED',
  'REFERENCE_MISMATCH', 'REFERENCE_AMOUNT_MISMATCH', 'REFERENCE_ALREADY_REVERSED', 'REFERENCE_EXPIRED']);

const wallet = z.strictObject({ id: uuid, playerId: uuid, balance: moneySchema, version: z.int().min(1), createdAt: timestamp, updatedAt: timestamp });
const transactionResult = z.strictObject({
  transactionId: uuid, status: z.enum(['PROCESSED', 'REJECTED', 'PENDING_REFERENCE']),
  balance: moneySchema.describe('Saldo observado no processamento; o replay devolve o mesmo valor.'),
  failureCode: failureCode.optional(), idempotentReplay: z.boolean(),
});
const transactionView = z.strictObject({
  id: uuid, kind: z.enum(['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']), walletId: uuid, playerId: uuid, money: moneySchema,
  status: z.enum(['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED']), failureCode: failureCode.nullable(),
  createdAt: timestamp, processedAt: timestamp.nullable(), command: wagerSchema.nullable(), referenceTransactionId: uuid.nullable(),
  result: transactionResult.nullable().describe('Resposta persistida: terminal quando existir, senão o aceite pendente.'),
});
const ledgerEntry = z.strictObject({
  id: uuid, walletId: uuid, transactionId: uuid, direction: z.enum(['CREDIT', 'DEBIT']), money: moneySchema,
  balanceBefore: moneySchema, balanceAfter: moneySchema, createdAt: timestamp,
});
const ledgerPage = z.strictObject({ entries: z.array(ledgerEntry), nextCursor: z.string().nullable() });
const reconciliation = z.strictObject({
  walletId: uuid, storedBalance: moneySchema, calculatedBalance: moneySchema,
  difference: moneySchema.describe('Saldo armazenado menos o calculado; pode ser negativo.'), consistent: z.boolean(), checkedEntries: z.int().min(0),
});
const errorBody = z.strictObject({ error: z.strictObject({ code: z.string(), message: z.string(), requestId: z.string().nullable() }) });
const readiness = z.strictObject({ status: z.literal('up'), dependencies: z.strictObject({ postgres: z.literal('up'), sqs: z.literal('up') }) });

/** Exportado para os testes validarem respostas reais contra a documentação. */
export const OPENAPI_SCHEMAS = {
  Money: moneySchema, OpenWalletRequest: openWalletSchema, WagerRequest: wagerSchema, Wallet: wallet,
  TransactionResult: transactionResult, Transaction: transactionView, LedgerEntry: ledgerEntry, LedgerPage: ledgerPage,
  Reconciliation: reconciliation, Error: errorBody, Readiness: readiness,
} as const;
type SchemaName = keyof typeof OPENAPI_SCHEMAS;

function componentSchemas(): Record<string, Record<string, unknown>> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(OPENAPI_SCHEMAS)) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, { uri: (id) => `#/components/schemas/${id}` });
  return Object.fromEntries(Object.entries(schemas).map(([id, { $schema: _schema, $id: _id, ...schema }]) => [id, schema]));
}

const { $schema: _identifierDialect, ...identifierSchema } = z.toJSONSchema(identifier);
const ref = (name: SchemaName) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: SchemaName, description: string) => ({ description, content: { 'application/json': { schema: ref(name) } } });
const error = (description: string) => json('Error', description);
const path = (name: string, description: string, schema: object = { type: 'string', format: 'uuid' }) =>
  ({ name, in: 'path', required: true, description, schema });

const betExample = {
  providerId: 'provider-a', externalTransactionId: 'bet-001', playerId: '7f3c2a10-5d4e-4b8f-9a61-2c3d4e5f6a7b',
  walletId: '0b9e7c55-1f2a-4d3b-8c4d-5e6f7a8b9c0d', roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
};

export function buildOpenApiDocument(version: string): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Distributed Wagering Processor', version,
      description: 'Wallets, apostas e resultados com idempotência persistente, ledger imutável e eventos via outbox. '
        + 'Dinheiro trafega como string decimal com duas casas. Comandos também podem chegar pela fila SQS wager-transactions.fifo; '
        + 'decisões e limitações estão no ARCHITECTURE.md do repositório.',
    },
    tags: [{ name: 'Wallets' }, { name: 'Transações' }, { name: 'Diagnóstico' }],
    components: { schemas: componentSchemas() },
    paths: {
      '/wallets': {
        post: {
          tags: ['Wallets'], summary: 'Criar wallet',
          description: 'Uma wallet por jogador e moeda. Saldo inicial positivo gera a transação OPENING e o crédito no ledger. Só BRL está habilitada.',
          requestBody: { required: true, content: { 'application/json': { schema: ref('OpenWalletRequest'),
            example: { playerId: betExample.playerId, initialBalance: { amount: '100.00', currency: 'BRL' } } } } },
          responses: { 201: json('Wallet', 'Wallet criada.'), 400: error('Payload inválido.'), 409: error('WALLET_ALREADY_EXISTS.'),
            503: error('Infraestrutura temporariamente indisponível.') },
        },
      },
      '/wallets/{walletId}': {
        get: {
          tags: ['Wallets'], summary: 'Consultar saldo e versão atuais', parameters: [path('walletId', 'ID da wallet.')],
          responses: { 200: json('Wallet', 'Wallet atual.'), 400: error('ID inválido.'), 404: error('WALLET_NOT_FOUND.') },
        },
      },
      '/wallets/{walletId}/ledger': {
        get: {
          tags: ['Wallets'], summary: 'Listar lançamentos do ledger',
          description: 'Ordem crescente de criação. Use nextCursor da resposta anterior para a próxima página.',
          parameters: [path('walletId', 'ID da wallet.'),
            { name: 'limit', in: 'query', required: false, description: 'De 1 a 100.', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { name: 'cursor', in: 'query', required: false, description: 'Cursor opaco devolvido em nextCursor.', schema: { type: 'string', maxLength: 512 } }],
          responses: { 200: json('LedgerPage', 'Página do ledger.'), 400: error('Parâmetro ou cursor inválido.') },
        },
      },
      '/wallets/{walletId}/reconciliation': {
        post: {
          tags: ['Wallets'], summary: 'Comparar saldo com o ledger',
          description: 'Leitura consistente (REPEATABLE READ). Divergência é sinalizada, logada e contada em métrica; nunca corrigida.',
          parameters: [path('walletId', 'ID da wallet.')],
          responses: { 200: json('Reconciliation', 'Resultado da comparação.'), 404: error('WALLET_NOT_FOUND.') },
        },
      },
      '/wagering/transactions': {
        post: {
          tags: ['Transações'], summary: 'Enviar BET, WIN, LOSS, REFUND ou ROLLBACK',
          description: 'Idempotente por provedor e Idempotency-Key. Mesma chave e mesmo payload devolvem o resultado original com '
            + 'idempotentReplay true. REFUND e ROLLBACK exigem referenceExternalTransactionId; WIN aceita opcionalmente; BET e LOSS recusam. '
            + 'Referência ainda ausente resulta em 202 PENDING_REFERENCE, resolvida depois pelo worker.',
          parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, description: 'Chave do provedor para esta operação.', schema: identifierSchema }],
          requestBody: { required: true, content: { 'application/json': { schema: ref('WagerRequest'), example: betExample } } },
          responses: {
            200: json('TransactionResult', 'Processada (ou replay de resultado processado).'),
            202: json('TransactionResult', 'Aceita aguardando a referência (PENDING_REFERENCE); não é resultado final.'),
            400: error('Payload ou header inválido (INVALID_PAYLOAD, MISSING_IDEMPOTENCY_KEY).'),
            404: error('WALLET_NOT_FOUND.'),
            409: error('IDEMPOTENCY_CONFLICT ou EXTERNAL_ID_CONFLICT.'),
            422: json('TransactionResult', 'Rejeição de negócio persistida, com failureCode e saldo observado.'),
            503: error('Infraestrutura temporariamente indisponível; reenviar com a mesma chave.'),
          },
        },
      },
      '/wagering/transactions/{transactionId}': {
        get: {
          tags: ['Transações'], summary: 'Consultar transação pelo ID interno', parameters: [path('transactionId', 'ID interno da transação.')],
          responses: { 200: json('Transaction', 'Estado atual e resposta persistida.'), 404: error('TRANSACTION_NOT_FOUND.') },
        },
      },
      '/providers/{providerId}/wagering/transactions/{externalTransactionId}': {
        get: {
          tags: ['Transações'], summary: 'Consultar transação pelo ID do provedor',
          parameters: [path('providerId', 'ID do provedor.', identifierSchema),
            path('externalTransactionId', 'ID externo da transação.', identifierSchema)],
          responses: { 200: json('Transaction', 'Estado atual e resposta persistida.'), 404: error('TRANSACTION_NOT_FOUND.') },
        },
      },
      '/health/live': {
        get: { tags: ['Diagnóstico'], summary: 'Liveness do processo',
          responses: { 200: { description: 'Processo no ar.', content: { 'application/json': { schema: { type: 'object', properties: { status: { const: 'up' } } } } } } } },
      },
      '/health/ready': {
        get: { tags: ['Diagnóstico'], summary: 'Readiness: schema na versão esperada e fila de comandos alcançável',
          responses: { 200: json('Readiness', 'Pronto para receber tráfego.'), 503: error('Dependência indisponível.') } },
      },
      '/metrics': {
        get: { tags: ['Diagnóstico'], summary: 'Métricas Prometheus',
          description: 'Contadores e histogramas deste processo, mais backlog da outbox e de referências pendentes lido do banco.',
          responses: { 200: { description: 'Formato de exposição do Prometheus.', content: { 'text/plain': { schema: { type: 'string' } } } } } },
      },
    },
  };
}
