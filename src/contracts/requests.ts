import { z } from 'zod';
import { AMOUNT_PATTERN } from '../domain/money';

export const uuid = z.string().uuid();
export const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const moneySchema = z.object({
  amount: z.string().max(21).regex(AMOUNT_PATTERN),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

export const openWalletSchema = z.object({ playerId: uuid, initialBalance: moneySchema }).strict();
const wagerFields = {
  providerId: identifier, externalTransactionId: identifier, playerId: uuid, walletId: uuid,
  roundId: identifier, gameId: identifier, money: moneySchema,
};
// BET e LOSS não aceitam referência; WIN aceita opcionalmente; REFUND e ROLLBACK exigem. OPENING não é aceito.
export const wagerSchema = z.discriminatedUnion('kind', [
  z.object({ ...wagerFields, kind: z.literal('BET') }).strict(),
  z.object({ ...wagerFields, kind: z.literal('LOSS') }).strict(),
  z.object({ ...wagerFields, kind: z.literal('WIN'), referenceExternalTransactionId: identifier.optional() }).strict(),
  z.object({ ...wagerFields, kind: z.literal('REFUND'), referenceExternalTransactionId: identifier }).strict(),
  z.object({ ...wagerFields, kind: z.literal('ROLLBACK'), referenceExternalTransactionId: identifier }).strict(),
]);

export const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.number().max(100)).default(50),
}).strict();

export const cursorSchema = z.object({ walletId: uuid, at: z.string().datetime(), id: uuid }).strict();

// Envelope da fila de comandos (§10). data repete o contrato HTTP e traz a chave de idempotência, que no HTTP vem do header.
export const wagerMessageSchema = z.object({
  messageId: identifier,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: z.looseObject({ idempotencyKey: identifier }),
}).strict();
