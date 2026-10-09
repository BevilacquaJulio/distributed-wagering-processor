import { z } from 'zod';
import { AMOUNT_PATTERN } from '../domain/money';

export const uuid = z.string().uuid();
export const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const moneySchema = z.object({
  amount: z.string().max(21).regex(AMOUNT_PATTERN),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

export const openWalletSchema = z.object({ playerId: uuid, initialBalance: moneySchema }).strict();
export const betSchema = z.object({
  providerId: identifier, externalTransactionId: identifier, playerId: uuid, walletId: uuid,
  roundId: identifier, gameId: identifier, kind: z.literal('BET'), money: moneySchema,
}).strict();

export const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.number().max(100)).default(50),
}).strict();

export const cursorSchema = z.object({ walletId: uuid, at: z.string().datetime(), id: uuid }).strict();
