import axios, { type AxiosResponse } from 'axios';
import { z } from 'zod';
import { recordRequest } from './request-log';

const baseURL = (import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '');
if (baseURL !== '/api') throw new Error('Este painel usa o proxy de mesma origem /api.');
export const api = axios.create({ baseURL, timeout: 15000 });

/** Ações do usuário ficam registradas em "Últimas requisições", inclusive as que voltam com erro. */
async function recorded(label: string, send: () => Promise<AxiosResponse>): Promise<AxiosResponse> {
  try {
    const response = await send();
    recordRequest(label, api.getUri(response.config), response.config, response);
    return response;
  } catch (error) {
    if (axios.isAxiosError(error) && error.config) recordRequest(label, api.getUri(error.config), error.config, error.response);
    throw error;
  }
}
const money = z.object({ amount: z.string().regex(/^-?(0|[1-9]\d*)\.\d{2}$/), currency: z.string().regex(/^[A-Z]{3}$/) });
export const walletSchema = z.object({ id: z.string().uuid(), playerId: z.string().uuid(), balance: money, version: z.number().int() });
export type Wallet = z.infer<typeof walletSchema>;
const resultSchema = z.object({
  transactionId: z.string().uuid(), status: z.enum(['PROCESSED', 'REJECTED', 'PENDING', 'PENDING_REFERENCE']),
  balance: money.optional(), idempotentReplay: z.boolean(), failureCode: z.string().optional(),
});
export type WagerResult = z.infer<typeof resultSchema>;
const transactionSchema = z.object({
  id: z.string().uuid(), kind: z.string(), walletId: z.string().uuid(), money, status: z.string(),
  failureCode: z.string().nullable(), createdAt: z.string(), processedAt: z.string().nullable(),
  referenceTransactionId: z.string().nullable(),
  command: z.object({ providerId: z.string(), externalTransactionId: z.string(), roundId: z.string(), gameId: z.string().optional(),
    referenceExternalTransactionId: z.string().optional() }).nullable(),
  result: resultSchema.nullable(),
});
export type TransactionView = z.infer<typeof transactionSchema>;
const ledgerPageSchema = z.object({ entries: z.array(z.object({ id: z.string(), transactionId: z.string(),
  direction: z.enum(['CREDIT', 'DEBIT']), money, balanceBefore: money, balanceAfter: money, createdAt: z.string() })), nextCursor: z.string().nullable() });
const reconciliationSchema = z.object({ storedBalance: money, calculatedBalance: money, difference: money, consistent: z.boolean() });

export const kinds = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type Kind = typeof kinds[number];
/** REFUND e ROLLBACK exigem referência; WIN aceita opcionalmente; BET e LOSS não aceitam. */
export const referencePolicy: Record<Kind, 'required' | 'optional' | 'forbidden'> = {
  BET: 'forbidden', LOSS: 'forbidden', WIN: 'optional', REFUND: 'required', ROLLBACK: 'required',
};
/** Tipos que cada operação pode referenciar; o servidor decide, isto só orienta as sugestões do painel. */
export const referenceableKinds: Record<Kind, readonly Kind[]> = {
  BET: [], LOSS: [], WIN: ['BET'], REFUND: ['BET'], ROLLBACK: ['BET', 'WIN', 'REFUND'],
};
export const isReversal = (kind: Kind) => kind === 'REFUND' || kind === 'ROLLBACK';
export const amountInput = z.string().regex(/^(0|[1-9]\d{0,17})\.\d{2}$/, 'Use um valor como 25.00, com duas casas decimais.');
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const identifierMessage = 'Use letras, números, ponto, hífen, dois-pontos ou sublinhado.';
const identifier = z.string().min(1, 'Preencha este campo.').max(128).regex(identifierPattern, identifierMessage);
export const walletInputSchema = z.object({ playerId: z.string().uuid('Informe um UUID válido.'), amount: amountInput });
export const operationInputSchema = z.object({ kind: z.enum(kinds), providerId: identifier, externalTransactionId: identifier,
  idempotencyKey: identifier, roundId: identifier, gameId: identifier, amount: amountInput, reference: z.string().max(128) })
  .superRefine((fields, context) => {
    const policy = referencePolicy[fields.kind];
    if (policy === 'required' && !fields.reference) {
      context.addIssue({ code: 'custom', path: ['reference'], message: 'Informe o ID externo da operação referenciada.' });
    } else if (fields.reference && !identifierPattern.test(fields.reference)) {
      context.addIssue({ code: 'custom', path: ['reference'], message: identifierMessage });
    }
  });
export type OperationInput = z.infer<typeof operationInputSchema>;
export type Submission = { wallet: Wallet; fields: OperationInput };

export async function getWallet(id: string, signal?: AbortSignal): Promise<Wallet> {
  return walletSchema.parse((await api.get(`/wallets/${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}) })).data);
}
export async function openWallet(fields: z.infer<typeof walletInputSchema>): Promise<Wallet> {
  const response = await recorded(`Criar wallet · ${fields.amount}`,
    () => api.post('/wallets', { playerId: fields.playerId, initialBalance: { amount: fields.amount, currency: 'BRL' } }));
  return walletSchema.parse(response.data);
}
export async function submitWager({ wallet, fields }: Submission, label = `${fields.kind} ${fields.amount}`): Promise<WagerResult> {
  const { amount, idempotencyKey, reference, ...identity } = fields;
  const withReference = reference && referencePolicy[fields.kind] !== 'forbidden';
  const response = await recorded(label, () => api.post('/wagering/transactions', {
    ...identity, playerId: wallet.playerId, walletId: wallet.id, money: { amount, currency: wallet.balance.currency },
    ...(withReference ? { referenceExternalTransactionId: reference } : {}),
  }, { headers: { 'Idempotency-Key': idempotencyKey }, validateStatus: (status) => status === 200 || status === 202 || status === 422 }));
  return resultSchema.parse(response.data);
}
export async function getTransaction(id: string): Promise<TransactionView> {
  return transactionSchema.parse((await recorded('Consultar por ID interno', () => api.get(`/wagering/transactions/${encodeURIComponent(id)}`))).data);
}
export async function getTransactionByExternal(providerId: string, externalTransactionId: string): Promise<TransactionView> {
  return transactionSchema.parse((await recorded(`Consultar ${externalTransactionId}`, () => api.get(
    `/providers/${encodeURIComponent(providerId)}/wagering/transactions/${encodeURIComponent(externalTransactionId)}`))).data);
}
export async function getLedger(id: string, cursor: string | null, signal?: AbortSignal) {
  return ledgerPageSchema.parse((await api.get(`/wallets/${encodeURIComponent(id)}/ledger`, {
    params: { limit: 10, ...(cursor ? { cursor } : {}) }, ...(signal ? { signal } : {}),
  })).data);
}
export async function reconcile(id: string) {
  return reconciliationSchema.parse((await recorded('Conferir saldo', () => api.post(`/wallets/${encodeURIComponent(id)}/reconciliation`))).data);
}

const messages: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'Saldo insuficiente para esta aposta.',
  REVERSAL_INSUFFICIENT_FUNDS: 'Saldo insuficiente para desfazer o crédito da operação referenciada.',
  AMOUNT_NOT_ALLOWED: 'Valor não permitido para este tipo: LOSS usa 0.00 e as demais operações exigem valor maior que zero.',
  BALANCE_LIMIT_EXCEEDED: 'O crédito ultrapassaria o saldo máximo permitido.',
  WALLET_PLAYER_MISMATCH: 'O jogador informado não é o dono desta wallet.',
  CURRENCY_MISMATCH: 'A moeda da operação é diferente da moeda da wallet.', CURRENCY_NOT_SUPPORTED: 'Moeda não habilitada.',
  INVALID_REFERENCE: 'Uma operação não pode referenciar a si mesma.',
  REFERENCE_NOT_PROCESSED: 'A operação referenciada foi rejeitada ou falhou.',
  REFERENCE_MISMATCH: 'A referência não é compatível: confira tipo, jogador, wallet, moeda e rodada.',
  REFERENCE_AMOUNT_MISMATCH: 'O valor da reversão precisa ser igual ao da operação referenciada.',
  REFERENCE_ALREADY_REVERSED: 'Esta operação já foi revertida (por REFUND ou ROLLBACK) e não aceita outra reversão.',
  REFERENCE_EXPIRED: 'A operação referenciada não chegou dentro do prazo.',
  IDEMPOTENCY_CONFLICT: 'Esta chave já foi usada com outros dados. Confira a operação ou gere uma nova identidade.',
  EXTERNAL_ID_CONFLICT: 'Este ID externo já está associado a outra chave.', WALLET_NOT_FOUND: 'Wallet não encontrada.',
  TRANSACTION_NOT_FOUND: 'Transação não encontrada. Confira o provedor e se o ID é o externo (ou o interno, no outro modo de busca).',
  RESOURCE_NOT_FOUND: 'Endereço não encontrado na API.', MISSING_IDEMPOTENCY_KEY: 'A chave de idempotência é obrigatória.',
  WALLET_ALREADY_EXISTS: 'O jogador já possui uma wallet nessa moeda.', INVALID_PAYLOAD: 'Confira os campos enviados.',
  INFRASTRUCTURE_UNAVAILABLE: 'Serviço indisponível. Atualize os dados ou reenvie a mesma operação com a mesma chave.',
};
export function failureMessage(code: string): string { return messages[code] ?? `Operação não concluída (${code}).`; }
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const parsed = z.object({ error: z.object({ code: z.string(), requestId: z.string().nullable().optional() }) }).safeParse(error.response?.data);
    if (parsed.success) return `${failureMessage(parsed.data.error.code)}${parsed.data.error.requestId ? ` Protocolo: ${parsed.data.error.requestId}` : ''}`;
    return 'Não foi possível confirmar a resposta. Consulte o saldo e use o reenvio da mesma operação.';
  }
  return 'A resposta recebida não pôde ser interpretada. Atualize os dados antes de continuar.';
}
