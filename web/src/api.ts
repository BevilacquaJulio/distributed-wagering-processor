import axios from 'axios';
import { z } from 'zod';

const baseURL = (import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '');
if (baseURL !== '/api') throw new Error('Este painel usa o proxy de mesma origem /api.');
export const api = axios.create({ baseURL, timeout: 15000 });
const money = z.object({ amount: z.string().regex(/^-?(0|[1-9]\d*)\.\d{2}$/), currency: z.string().regex(/^[A-Z]{3}$/) });
export const walletSchema = z.object({ id: z.string().uuid(), playerId: z.string().uuid(), balance: money, version: z.number().int() });
export type Wallet = z.infer<typeof walletSchema>;
const resultSchema = z.object({
  transactionId: z.string().uuid(), status: z.enum(['PROCESSED', 'REJECTED', 'PENDING', 'PENDING_REFERENCE']),
  balance: money.optional(), idempotentReplay: z.boolean(), failureCode: z.string().optional(),
});
export type BetResult = z.infer<typeof resultSchema>;
const ledgerPageSchema = z.object({ entries: z.array(z.object({ id: z.string(), transactionId: z.string(),
  direction: z.enum(['CREDIT', 'DEBIT']), money, balanceBefore: money, balanceAfter: money, createdAt: z.string() })), nextCursor: z.string().nullable() });
const reconciliationSchema = z.object({ storedBalance: money, calculatedBalance: money, difference: money, consistent: z.boolean() });
export const amountInput = z.string().regex(/^(0|[1-9]\d{0,17})\.\d{2}$/, 'Use um valor como 25.00, com duas casas decimais.');
const identifier = z.string().min(1, 'Preencha este campo.').max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Use letras, números, ponto, hífen, dois-pontos ou sublinhado.');
export const walletInputSchema = z.object({ playerId: z.string().uuid('Informe um UUID válido.'), amount: amountInput });
export const betInputSchema = z.object({ providerId: identifier, externalTransactionId: identifier, idempotencyKey: identifier,
  roundId: identifier, gameId: identifier, amount: amountInput });
export type BetInput = z.infer<typeof betInputSchema>;
export type Submission = { wallet: Wallet; fields: BetInput };

export async function getWallet(id: string, signal?: AbortSignal): Promise<Wallet> {
  return walletSchema.parse((await api.get(`/wallets/${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}) })).data);
}
export async function openWallet(fields: z.infer<typeof walletInputSchema>): Promise<Wallet> {
  return walletSchema.parse((await api.post('/wallets', { playerId: fields.playerId, initialBalance: { amount: fields.amount, currency: 'BRL' } })).data);
}
export async function submitBet({ wallet, fields }: Submission): Promise<BetResult> {
  const { amount, idempotencyKey, ...identity } = fields;
  const response = await api.post('/wagering/transactions', {
    ...identity, playerId: wallet.playerId, walletId: wallet.id, kind: 'BET', money: { amount, currency: wallet.balance.currency },
  }, { headers: { 'Idempotency-Key': idempotencyKey }, validateStatus: (status) => status === 200 || status === 202 || status === 422 });
  return resultSchema.parse(response.data);
}
export async function getLedger(id: string, cursor: string | null, signal?: AbortSignal) {
  return ledgerPageSchema.parse((await api.get(`/wallets/${encodeURIComponent(id)}/ledger`, {
    params: { limit: 10, ...(cursor ? { cursor } : {}) }, ...(signal ? { signal } : {}),
  })).data);
}
export async function reconcile(id: string) {
  return reconciliationSchema.parse((await api.post(`/wallets/${encodeURIComponent(id)}/reconciliation`)).data);
}

const messages: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'Saldo insuficiente para esta aposta.', AMOUNT_NOT_ALLOWED: 'O valor da aposta deve ser maior que zero.',
  IDEMPOTENCY_CONFLICT: 'Esta chave já foi usada com outros dados. Confira a operação ou gere uma nova identidade.',
  EXTERNAL_ID_CONFLICT: 'Este ID externo já está associado a outra chave.', WALLET_NOT_FOUND: 'Wallet não encontrada.',
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
