import { LedgerEntry } from '../../domain/ledger-entry';
import { WagerTransaction } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import type { LedgerRow, TransactionRow, WalletRow } from './entities';

export function walletFromRow(row: WalletRow): Wallet {
  return Wallet.rehydrate({ id: row.id, playerId: row.playerId, balance: { amount: row.balance, currency: row.currency },
    version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
}
export function walletToRow(wallet: Wallet): WalletRow {
  const state = wallet.toState();
  return { id: state.id, playerId: state.playerId, balance: state.balance.amount, currency: state.balance.currency,
    version: state.version, createdAt: new Date(state.createdAt), updatedAt: new Date(state.updatedAt) };
}
export function transactionFromRow(row: TransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({ id: row.id, walletId: row.walletId, playerId: row.playerId, kind: row.kind,
    money: { amount: row.amount, currency: row.currency }, status: row.status, failureCode: row.failureCode,
    command: row.command, createdAt: row.createdAt.toISOString(), processedAt: row.processedAt?.toISOString() ?? null });
}
export function transactionToRow(transaction: WagerTransaction): TransactionRow {
  const state = transaction.toState();
  return { id: state.id, walletId: state.walletId, playerId: state.playerId, kind: state.kind,
    amount: state.money.amount, currency: state.money.currency, status: state.status, failureCode: state.failureCode,
    command: state.command, createdAt: new Date(state.createdAt), processedAt: state.processedAt ? new Date(state.processedAt) : null };
}
export function ledgerFromRow(row: LedgerRow): LedgerEntry {
  return LedgerEntry.rehydrate({ id: row.id, walletId: row.walletId, transactionId: row.transactionId,
    direction: row.direction, money: { amount: row.amount, currency: row.currency },
    balanceBefore: { amount: row.balanceBefore, currency: row.currency }, balanceAfter: { amount: row.balanceAfter, currency: row.currency },
    createdAt: row.createdAt.toISOString() });
}
export function ledgerToRow(entry: LedgerEntry): LedgerRow {
  const state = entry.toState();
  return { id: state.id, walletId: state.walletId, transactionId: state.transactionId, direction: state.direction,
    amount: state.money.amount, currency: state.money.currency, balanceBefore: state.balanceBefore.amount,
    balanceAfter: state.balanceAfter.amount, createdAt: new Date(state.createdAt) };
}
