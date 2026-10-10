import { type ReactNode, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage, failureMessage, isReversal, type Kind, kinds, type OperationInput, operationInputSchema, referenceableKinds,
  referencePolicy, type Submission, submitWager, type Wallet, type WagerResult } from './api';
import type { HelpTopic } from './help';
import { type SentOperation, StatusBadge } from './history';
import { CopyButton, Field, Heading, InfoButton } from './ui';

const kindLabels: Record<Kind, string> = {
  BET: 'BET · aposta (debita)', WIN: 'WIN · prêmio (credita)', LOSS: 'LOSS · perda (não movimenta)',
  REFUND: 'REFUND · estorno de uma BET', ROLLBACK: 'ROLLBACK · desfaz BET, WIN ou REFUND',
};
const httpStatus: Record<WagerResult['status'], number> = { PROCESSED: 200, PENDING_REFERENCE: 202, REJECTED: 422, PENDING: 202 };
const statusExplanation: Record<WagerResult['status'], string> = {
  PROCESSED: 'Gravada e aplicada ao saldo e ao extrato.',
  PENDING_REFERENCE: 'A operação referenciada ainda não foi encontrada. O saldo não mudou; o worker processa assim que ela chegar, ou rejeita após 24h.',
  REJECTED: 'Recusada por uma regra de negócio. A rejeição fica gravada e o saldo não mudou.',
  PENDING: 'Recebida e ainda sem resultado final.',
};

function newIdentity(kind: Kind): Pick<OperationInput, 'externalTransactionId' | 'idempotencyKey'> {
  const externalTransactionId = `${kind.toLowerCase()}-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  return { externalTransactionId, idempotencyKey: `key-${externalTransactionId}` };
}

function newOperation(kind: Kind = 'BET'): OperationInput {
  return { kind, providerId: 'provider-a', ...newIdentity(kind), roundId: 'round-1', gameId: 'game-1', amount: kind === 'LOSS' ? '0.00' : '25.00', reference: '' };
}

function ResultPanel({ sent, onLookup }: Readonly<{ sent: SentOperation | undefined; onLookup(providerId: string, externalId: string): void }>) {
  const result = sent?.result;
  return <section className="panel" aria-live="polite">
    <Heading eyebrow="Último envio" title="Resultado" topic="result" />
    {!sent && <p className="muted">Envie uma operação para ver aqui o status, o ID externo e o saldo observado.</p>}
    {sent && <div className={`result ${result?.status === 'PROCESSED' ? '' : result?.status === 'REJECTED' || !result ? 'rejected' : 'waiting'}`}>
      <div className="result-head">
        <span className="kind-tag">{sent.fields.kind}</span><StatusBadge operation={sent} />
        {result && <span className="muted text-xs">HTTP {httpStatus[result.status]}</span>}
        {result?.idempotentReplay && <span className="badge badge-neutral">Replay</span>}
      </div>
      {result && <p>{result.idempotentReplay ? 'Resultado já gravado devolvido sem nova movimentação. ' : ''}{statusExplanation[result.status]}</p>}
      {result?.failureCode && <p className="font-semibold">{failureMessage(result.failureCode)} <span className="mono">({result.failureCode})</span></p>}
      {sent.error && <p className="font-semibold">{sent.error}</p>}
      <dl className="result-grid">
        <dt>ID externo</dt>
        <dd className="fact-id"><span className="mono truncate">{sent.fields.externalTransactionId}</span><CopyButton value={sent.fields.externalTransactionId} label="ID externo" /></dd>
        {result?.balance && <><dt>Saldo observado</dt><dd className="money">{result.balance.amount} {result.balance.currency}</dd></>}
        {result && <><dt>ID interno</dt><dd className="mono break-all muted">{result.transactionId}</dd></>}
      </dl>
      {result?.status === 'PENDING_REFERENCE' && <button type="button" className="mt-2" onClick={() => onLookup(sent.fields.providerId, sent.fields.externalTransactionId)}>
        Consultar estado atual</button>}
    </div>}
  </section>;
}

/** Operações desta sessão que o tipo escolhido pode referenciar; o servidor continua sendo quem valida. */
function suggestionsFor(kind: Kind, providerId: string, history: SentOperation[]): SentOperation[] {
  const seen = new Set<string>();
  return [...history].reverse().filter((item) => {
    if (seen.has(item.fields.externalTransactionId)) return false;
    seen.add(item.fields.externalTransactionId);
    return item.result !== undefined && item.result.status !== 'REJECTED' && item.fields.providerId === providerId
      && referenceableKinds[kind].includes(item.fields.kind);
  }).slice(0, 4);
}

export function OperationForm({ wallet, history, onSent, onLookup, side }: Readonly<{
  wallet: Wallet; history: SentOperation[]; onSent(operation: Omit<SentOperation, 'seq'>): void;
  onLookup(providerId: string, externalId: string): void; side: ReactNode;
}>) {
  const queryClient = useQueryClient();
  const [last, setLast] = useState<Submission | null>(null);
  const form = useForm<OperationInput>({ resolver: zodResolver(operationInputSchema), defaultValues: newOperation() });
  const [kind, providerId, reference] = form.watch(['kind', 'providerId', 'reference']);
  const policy = referencePolicy[kind];
  const errors = form.formState.errors;
  const mutation = useMutation({
    mutationFn: ({ submission }: { submission: Submission; replay: boolean }) => submitWager(submission), retry: false,
    onSettled: async (data, error, { submission, replay }) => {
      onSent({ walletId: submission.wallet.id, fields: submission.fields, at: new Date().toISOString(), replay,
        result: data, error: error ? errorMessage(error) : undefined });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['wallet', submission.wallet.id] }),
        queryClient.invalidateQueries({ queryKey: ['ledger', submission.wallet.id] }),
      ]);
    },
  });
  const lastSent = history.at(-1);
  const suggestions = policy === 'forbidden' ? [] : suggestionsFor(kind, providerId, history);
  const internalMatch = reference ? history.find((item) => item.result?.transactionId === reference.trim()) : undefined;

  function changeKind(next: Kind) {
    const current = form.getValues();
    const amount = next === 'LOSS' ? '0.00' : kind === 'LOSS' ? '25.00' : current.amount;
    form.reset({ ...current, kind: next, amount, reference: referencePolicy[next] === 'forbidden' ? '' : current.reference, ...newIdentity(next) });
  }

  function applyReference(item: SentOperation) {
    form.setValue('reference', item.fields.externalTransactionId, { shouldValidate: true });
    form.setValue('roundId', item.fields.roundId, { shouldValidate: true });
    if (isReversal(kind)) form.setValue('amount', item.fields.amount, { shouldValidate: true });
  }

  const text = (name: Exclude<keyof OperationInput, 'kind'>, label: string, topic: HelpTopic, className = '') =>
    <Field id={`op-${name}`} label={label} topic={topic} error={errors[name]?.message} className={className}>
      <input id={`op-${name}`} {...form.register(name)} inputMode={name === 'amount' ? 'decimal' : 'text'} aria-invalid={!!errors[name]}
        autoComplete="off" spellCheck={false} />
    </Field>;

  return <div className="operate-grid">
    <section className="panel">
      <Heading eyebrow="Passo 2" title="Enviar operação" topic="kind" />
      <form noValidate onSubmit={form.handleSubmit((values) => {
        const submission = structuredClone({ wallet, fields: values });
        setLast(submission);
        mutation.mutate({ submission, replay: false });
        // O próximo envio de negócio usa identidade nova; repetir a anterior é só pelo reenvio controlado.
        const identity = newIdentity(values.kind);
        form.setValue('externalTransactionId', identity.externalTransactionId);
        form.setValue('idempotencyKey', identity.idempotencyKey);
      })}>
        <fieldset disabled={mutation.isPending} className="form-grid">
          <Field id="op-kind" label="Tipo" topic="kind" className="col-span-full">
            <select id="op-kind" {...form.register('kind', { onChange: (event) => { changeKind(event.target.value as Kind); mutation.reset(); } })}>
              {kinds.map((value) => <option key={value} value={value}>{kindLabels[value]}</option>)}
            </select>
          </Field>
          {text('amount', `Valor · ${wallet.balance.currency}`, 'amount')}
          {text('providerId', 'Provedor', 'provider')}
          {policy !== 'forbidden' && <div className="col-span-full reference-box">
            {text('reference', `ID externo referenciado${policy === 'optional' ? ' (opcional)' : ''}`, 'reference')}
            {internalMatch && <p role="alert" className="warning">
              Isto é o ID interno de uma {internalMatch.fields.kind}. A referência usa o ID externo:{' '}
              <button type="button" className="text-button" onClick={() => applyReference(internalMatch)}>usar {internalMatch.fields.externalTransactionId}</button>
            </p>}
            {suggestions.length > 0
              ? <div className="suggestions"><span className="muted text-xs">Referenciar uma operação desta sessão{isReversal(kind) ? ' (copia valor e rodada)' : ' (copia a rodada)'}:</span>
                <div className="chips">{suggestions.map((item) => <button key={item.seq} type="button" className="chip" onClick={() => applyReference(item)}>
                  <b>{item.fields.kind}</b> {item.fields.amount} · <span className="mono">{item.fields.externalTransactionId}</span>
                </button>)}</div></div>
              : <p className="muted text-xs">Nenhuma operação compatível enviada nesta sessão. Envie a {referenceableKinds[kind].join(', ')} primeiro ou digite o ID externo dela.</p>}
          </div>}
          {text('externalTransactionId', 'ID externo', 'externalId')}
          {text('idempotencyKey', 'Chave de idempotência', 'idempotencyKey')}
          {text('roundId', 'Rodada', 'round')}
          {text('gameId', 'Jogo', 'game')}
          <div className="col-span-full form-actions">
            <button type="submit" className="primary">{mutation.isPending ? 'Enviando…' : 'Enviar operação'}</button>
            {last && <span className="inline-flex items-center gap-1">
              <button type="button" onClick={() => mutation.mutate({ submission: last, replay: true })}>Reenviar a última ({last.fields.kind})</button>
              <InfoButton topic="replay" />
            </span>}
            <button type="button" className="text-button ml-auto" onClick={() => { form.reset(newOperation(kind)); mutation.reset(); }}>Restaurar padrões</button>
          </div>
        </fieldset>
      </form>
    </section>
    <div className="side-stack">
      <ResultPanel sent={lastSent} onLookup={onLookup} />
      {side}
    </div>
  </div>;
}
