import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { errorMessage, failureMessage, type Kind, kinds, openWallet, type OperationInput, operationInputSchema, referencePolicy,
  type Submission, submitWager, type Wallet, type WagerResult, walletInputSchema } from './api';

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

const kindLabels: Record<Kind, string> = { BET: 'BET · aposta', WIN: 'WIN · prêmio', LOSS: 'LOSS · perda', REFUND: 'REFUND · estorno', ROLLBACK: 'ROLLBACK · reversão' };
const statusTitles: Record<WagerResult['status'], string> = {
  PROCESSED: 'Operação processada', REJECTED: 'Operação rejeitada', PENDING: 'Operação pendente', PENDING_REFERENCE: 'Aguardando a operação referenciada',
};

function newOperation(kind: Kind = 'BET', reference = ''): OperationInput {
  const id = crypto.randomUUID();
  return { kind, providerId: 'provider-a', externalTransactionId: id, idempotencyKey: `provider-a:${id}`,
    roundId: 'round-1', gameId: 'game-1', amount: kind === 'LOSS' ? '0.00' : '25.00', reference };
}

function ResultCard({ result }: Readonly<{ result: WagerResult }>) {
  return <div className={`result ${result.status === 'REJECTED' ? 'rejected' : ''}`} aria-live="polite">
    <strong>{statusTitles[result.status]}</strong>
    <p>{result.idempotentReplay ? 'Replay: resultado persistido, sem nova movimentação.' : 'Resposta recebida do processador.'}</p>
    {result.status === 'PENDING_REFERENCE' && <p>Aceita com HTTP 202: ainda não é resultado financeiro final. Ela será processada quando a referência for confirmada.</p>}
    {result.failureCode && <p>{failureMessage(result.failureCode)}</p>}
    {result.balance && <p>Saldo observado nesta resposta: <b className="money">{result.balance.amount} {result.balance.currency}</b></p>}
    <p className="mono break-all">{result.transactionId}</p>
  </div>;
}

export function OperationForm({ wallet }: Readonly<{ wallet: Wallet }>) {
  const queryClient = useQueryClient();
  const [last, setLast] = useState<Submission | null>(null);
  const form = useForm<OperationInput>({ resolver: zodResolver(operationInputSchema), defaultValues: newOperation() });
  const kind = form.watch('kind');
  const policy = referencePolicy[kind];
  const mutation = useMutation({ mutationFn: submitWager, retry: false, onSettled: async (_data, _error, submission) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['wallet', submission.wallet.id] }),
      queryClient.invalidateQueries({ queryKey: ['ledger', submission.wallet.id] }),
    ]);
  } });
  const fields: { name: Exclude<keyof OperationInput, 'kind'>; label: string; wide?: boolean }[] = [
    { name: 'amount', label: 'Valor · BRL' }, { name: 'providerId', label: 'Provedor' },
    ...(policy === 'forbidden' ? [] : [{ name: 'reference' as const, label: `ID externo referenciado${policy === 'optional' ? ' (opcional)' : ''}`, wide: true }]),
    { name: 'externalTransactionId', label: 'ID externo', wide: true }, { name: 'idempotencyKey', label: 'Chave de idempotência', wide: true },
    { name: 'roundId', label: 'Rodada' }, { name: 'gameId', label: 'Jogo' },
  ];
  return <section className="panel">
    <div className="section-heading"><div><p className="eyebrow">Operação financeira</p><h2>Enviar operação</h2></div><span className="tag">{kind}</span></div>
    <form onSubmit={form.handleSubmit((values) => {
      const submission = structuredClone({ wallet, fields: values });
      setLast(submission); mutation.mutate(submission);
    })}>
      <fieldset disabled={mutation.isPending} className="grid gap-4 sm:grid-cols-2">
        <label className="sm:col-span-2">Tipo<select {...form.register('kind', { onChange: (event) => {
          form.reset(newOperation(event.target.value as Kind, form.getValues('reference'))); mutation.reset();
        } })}>{kinds.map((value) => <option key={value} value={value}>{kindLabels[value]}</option>)}</select></label>
        {fields.map(({ name, label, wide }) => <label key={name} className={wide ? 'sm:col-span-2' : ''}>
          {label}<input {...form.register(name)} inputMode={name === 'amount' ? 'decimal' : 'text'} aria-invalid={!!form.formState.errors[name]} />
          {form.formState.errors[name] && <span role="alert" className="error">{form.formState.errors[name]?.message}</span>}
        </label>)}
        <div className="flex flex-wrap gap-3 sm:col-span-2 mt-2">
          <button type="submit" className="primary">{mutation.isPending ? 'Enviando…' : 'Enviar operação'}</button>
          <button type="button" onClick={() => { form.reset(newOperation(kind)); setLast(null); mutation.reset(); }}>Nova operação</button>
          {last && policy !== 'forbidden' && <button type="button" onClick={() => form.setValue('reference', last.fields.externalTransactionId, { shouldValidate: true })}>
            Referenciar o último envio</button>}
        </div>
      </fieldset>
    </form>
    {last && <div className="replay-strip"><div><strong>Reenvio controlado</strong><p>Repete os dados e a chave do último envio ({last.fields.kind}).</p></div>
      <button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate(last)}>Reenviar mesma operação</button></div>}
    {mutation.isError && <p role="alert" className="error mt-4">{errorMessage(mutation.error)}</p>}
    {mutation.data && <ResultCard result={mutation.data} />}
  </section>;
}
