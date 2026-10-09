import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { betInputSchema, type BetInput, errorMessage, failureMessage, openWallet, type Submission, submitBet, type Wallet, walletInputSchema } from './api';

export function WalletForm({ onCreated }: { onCreated(wallet: Wallet): void }) {
  const form = useForm<z.infer<typeof walletInputSchema>>({ resolver: zodResolver(walletInputSchema), defaultValues: { playerId: '', amount: '100.00' } });
  const mutation = useMutation({ mutationFn: openWallet, onSuccess: onCreated, retry: false });
  return <form onSubmit={form.handleSubmit((fields) => mutation.mutate(fields))} className="space-y-4">
    <label>Jogador <span className="hint">UUID</span><input {...form.register('playerId')} aria-invalid={!!form.formState.errors.playerId} placeholder="ID do jogador" /></label>
    <button type="button" className="link-button" onClick={() => form.setValue('playerId', crypto.randomUUID(), { shouldValidate: true })}>Gerar ID de teste</button>
    <label>Saldo inicial · BRL<input {...form.register('amount')} inputMode="decimal" aria-invalid={!!form.formState.errors.amount} /></label>
    <p role="alert" className="error">{form.formState.errors.playerId?.message || form.formState.errors.amount?.message}</p>
    <button type="submit" disabled={mutation.isPending} className="primary w-full">{mutation.isPending ? 'Criando…' : 'Criar wallet'}</button>
    {mutation.isError && <p role="alert" className="error">{errorMessage(mutation.error)}</p>}
  </form>;
}

function newOperation(): BetInput {
  const id = crypto.randomUUID();
  return { providerId: 'provider-a', externalTransactionId: id, idempotencyKey: `provider-a:${id}`, roundId: 'round-1', gameId: 'game-1', amount: '25.00' };
}

export function BetForm({ wallet }: { wallet: Wallet }) {
  const queryClient = useQueryClient();
  const [last, setLast] = useState<Submission | null>(null);
  const form = useForm<BetInput>({ resolver: zodResolver(betInputSchema), defaultValues: newOperation() });
  const mutation = useMutation({ mutationFn: submitBet, retry: false, onSettled: async (_data, _error, submission) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['wallet', submission.wallet.id] }),
      queryClient.invalidateQueries({ queryKey: ['ledger', submission.wallet.id] }),
    ]);
  } });
  const fields: { name: keyof BetInput; label: string }[] = [
    { name: 'amount', label: 'Valor da aposta · BRL' }, { name: 'providerId', label: 'Provedor' },
    { name: 'externalTransactionId', label: 'ID externo' }, { name: 'idempotencyKey', label: 'Chave de idempotência' },
    { name: 'roundId', label: 'Rodada' }, { name: 'gameId', label: 'Jogo' },
  ];
  return <section className="panel">
    <div className="section-heading"><div><p className="eyebrow">Operação financeira</p><h2>Enviar aposta</h2></div><span className="tag">BET</span></div>
    <form onSubmit={form.handleSubmit((values) => {
      const submission = structuredClone({ wallet, fields: values });
      setLast(submission); mutation.mutate(submission);
    })}>
      <fieldset disabled={mutation.isPending} className="grid gap-4 sm:grid-cols-2">
        {fields.map(({ name, label }) => <label key={name} className={name === 'idempotencyKey' || name === 'externalTransactionId' ? 'sm:col-span-2' : ''}>
          {label}<input {...form.register(name)} inputMode={name === 'amount' ? 'decimal' : 'text'} aria-invalid={!!form.formState.errors[name]} />
          {form.formState.errors[name] && <span role="alert" className="error">{form.formState.errors[name]?.message}</span>}
        </label>)}
        <div className="flex flex-wrap gap-3 sm:col-span-2 mt-2">
          <button type="submit" className="primary">{mutation.isPending ? 'Enviando…' : 'Enviar aposta'}</button>
          <button type="button" onClick={() => { form.reset(newOperation()); setLast(null); mutation.reset(); }}>Nova operação</button>
        </div>
      </fieldset>
    </form>
    {last && <div className="replay-strip"><div><strong>Reenvio controlado</strong><p>Repete os dados e a chave do último envio.</p></div>
      <button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate(last)}>Reenviar mesma operação</button></div>}
    {mutation.isError && <p role="alert" className="error mt-4">{errorMessage(mutation.error)}</p>}
    {mutation.data && <div className={`result ${mutation.data.status === 'REJECTED' ? 'rejected' : ''}`} aria-live="polite">
      <strong>{mutation.data.status === 'PROCESSED' ? 'Aposta processada' : mutation.data.status === 'REJECTED' ? 'Aposta rejeitada' : 'Operação pendente'}</strong>
      <p>{mutation.data.idempotentReplay ? 'Replay: resultado original, sem nova movimentação.' : 'Resposta recebida do processador.'}</p>
      {mutation.data.failureCode && <p>{failureMessage(mutation.data.failureCode)}</p>}
      {mutation.data.balance && <p>Saldo observado nesta resposta: <b className="money">{mutation.data.balance.amount} {mutation.data.balance.currency}</b></p>}
      <p className="mono break-all">{mutation.data.transactionId}</p>
    </div>}
  </section>;
}
