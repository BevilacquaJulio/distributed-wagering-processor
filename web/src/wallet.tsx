import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { errorMessage, openWallet, type Wallet, walletInputSchema } from './api';
import { CopyButton, Field, Heading, InfoButton } from './ui';

export interface RecentWallet { id: string; playerId: string }
const RECENT_KEY = 'jungle-panel:recent-wallets';
const recentSchema = z.array(z.object({ id: z.string().uuid(), playerId: z.string().uuid() }));

/** Conveniência deste navegador: só IDs, nunca saldo. Armazenamento indisponível não impede o uso do painel. */
export function readRecentWallets(): RecentWallet[] {
  try {
    const parsed = recentSchema.safeParse(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch { return []; }
}
export function rememberWallet(wallet: RecentWallet): RecentWallet[] {
  const next = [wallet, ...readRecentWallets().filter((item) => item.id !== wallet.id)].slice(0, 5);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* a lista some ao recarregar, sem outro efeito */ }
  return next;
}

function CreateWallet({ onCreated }: Readonly<{ onCreated(wallet: Wallet): void }>) {
  const form = useForm<z.infer<typeof walletInputSchema>>({ resolver: zodResolver(walletInputSchema), defaultValues: { playerId: '', amount: '100.00' } });
  const mutation = useMutation({ mutationFn: openWallet, onSuccess: onCreated, retry: false });
  const errors = form.formState.errors;
  return <form onSubmit={form.handleSubmit((fields) => mutation.mutate(fields))} className="space-y-4" noValidate>
    <Field id="wallet-player" label="Jogador (UUID)" topic="player" error={errors.playerId?.message}>
      <div className="input-action">
        <input id="wallet-player" {...form.register('playerId')} aria-invalid={!!errors.playerId} placeholder="Gere ou cole um UUID" />
        <button type="button" onClick={() => form.setValue('playerId', crypto.randomUUID(), { shouldValidate: true })}>Gerar</button>
      </div>
    </Field>
    <Field id="wallet-amount" label="Saldo inicial · BRL" topic="initialBalance" error={errors.amount?.message}>
      <input id="wallet-amount" {...form.register('amount')} inputMode="decimal" aria-invalid={!!errors.amount} />
    </Field>
    <button type="submit" disabled={mutation.isPending} className="primary w-full">{mutation.isPending ? 'Criando…' : 'Criar wallet'}</button>
    {mutation.isError && <p role="alert" className="error">{errorMessage(mutation.error)}</p>}
  </form>;
}

function OpenWallet({ recent, onOpen }: Readonly<{ recent: RecentWallet[]; onOpen(id: string): void }>) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  return <div className="space-y-4">
    <form noValidate onSubmit={(event) => {
      event.preventDefault();
      const parsed = z.string().uuid().safeParse(value.trim());
      if (!parsed.success) { setError('Informe o UUID da wallet (não o do jogador).'); return; }
      setError(''); onOpen(parsed.data);
    }} className="space-y-3">
      <Field id="open-wallet" label="ID da wallet" topic="walletId" error={error}>
        <div className="input-action">
          <input id="open-wallet" value={value} onChange={(event) => setValue(event.target.value)} aria-invalid={!!error} placeholder="UUID da wallet" />
          <button type="submit">Abrir</button>
        </div>
      </Field>
    </form>
    <div>
      <div className="field-head"><h3 className="small-title">Wallets recentes</h3><InfoButton topic="recentWallets" /></div>
      {recent.length === 0
        ? <p className="muted">Nenhuma wallet aberta neste navegador ainda.</p>
        : <ul className="recent-list">{recent.map((item) => <li key={item.id}>
          <button type="button" className="recent-item" onClick={() => onOpen(item.id)}>
            <span className="mono">{item.id}</span><small>Jogador {item.playerId.slice(0, 8)}…</small>
          </button>
        </li>)}</ul>}
    </div>
  </div>;
}

export function WalletSetup({ recent, onCreated, onOpen, error }: Readonly<{
  recent: RecentWallet[]; onCreated(wallet: Wallet): void; onOpen(id: string): void; error?: string | undefined;
}>) {
  return <section className="panel setup">
    <Heading eyebrow="Passo 1" title="Escolha uma wallet" topic="walletId" />
    <p className="muted -mt-2 mb-6">Toda operação movimenta uma wallet. Crie uma nova para testar do zero ou reabra uma que você já usou.</p>
    {error && <p role="alert" className="error mb-4">{error}</p>}
    <div className="setup-grid">
      <div><h3 className="small-title mb-4">Criar wallet</h3><CreateWallet onCreated={onCreated} /></div>
      <div className="setup-divider" aria-hidden="true" />
      <div><h3 className="small-title mb-4">Abrir wallet existente</h3><OpenWallet recent={recent} onOpen={onOpen} /></div>
    </div>
  </section>;
}

export function WalletSummary({ wallet, refreshing, onRefresh, onChange }: Readonly<{
  wallet: Wallet; refreshing: boolean; onRefresh(): void; onChange(): void;
}>) {
  return <section className="wallet-bar" aria-label="Wallet aberta">
    <div className="wallet-balance">
      <div className="field-head"><p className="eyebrow">Saldo atual</p><InfoButton topic="balance" /></div>
      <p className="current-balance">{wallet.balance.amount}<span>{wallet.balance.currency}</span></p>
    </div>
    <div className="wallet-facts">
      <div><div className="field-head"><p className="eyebrow">Versão</p><InfoButton topic="version" /></div><p className="fact">{wallet.version}</p></div>
      <div className="min-w-0"><div className="field-head"><p className="eyebrow">Wallet</p><InfoButton topic="walletId" /></div>
        <p className="fact-id"><span className="mono truncate" title={wallet.id}>{wallet.id}</span><CopyButton value={wallet.id} label="ID da wallet" /></p></div>
      <div className="min-w-0"><div className="field-head"><p className="eyebrow">Jogador</p><InfoButton topic="player" /></div>
        <p className="fact-id"><span className="mono truncate" title={wallet.playerId}>{wallet.playerId}</span><CopyButton value={wallet.playerId} label="ID do jogador" /></p></div>
    </div>
    <div className="wallet-actions">
      <button type="button" disabled={refreshing} onClick={onRefresh}>{refreshing ? 'Atualizando…' : 'Atualizar'}</button>
      <button type="button" onClick={onChange}>Trocar wallet</button>
    </div>
  </section>;
}
