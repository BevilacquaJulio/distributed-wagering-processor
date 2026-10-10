import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { errorMessage, failureMessage, getTransaction, getTransactionByExternal, type TransactionView } from './api';
import { CopyButton, Field, Heading } from './ui';

type Search = { mode: 'internal'; id: string } | { mode: 'external'; providerId: string; externalTransactionId: string };
export interface LookupRequest { providerId: string; externalTransactionId: string; nonce: number }

const statusText: Record<string, string> = {
  PROCESSED: 'Processada: gravada e aplicada.', REJECTED: 'Rejeitada: a rejeição está gravada e o saldo não mudou.',
  PENDING_REFERENCE: 'Aguardando referência: ainda pode ser processada ou rejeitada.', FAILED: 'Falhou: estado final, sem movimentação.',
  PENDING: 'Pendente: ainda sem resultado final.',
};

function find(search: Search): Promise<TransactionView> {
  return search.mode === 'internal' ? getTransaction(search.id) : getTransactionByExternal(search.providerId, search.externalTransactionId);
}

const dateTime = (value: string | null) => value ? new Date(value).toLocaleString('pt-BR') : 'ainda não processada';

function Details({ transaction }: Readonly<{ transaction: TransactionView }>) {
  const rows: [string, string][] = [
    ['Tipo', transaction.kind], ['Valor', `${transaction.money.amount} ${transaction.money.currency}`],
    ['Provedor', transaction.command?.providerId ?? 'interno'],
    ['ID externo', transaction.command?.externalTransactionId ?? 'abertura interna'],
    ['Rodada', transaction.command?.roundId ?? '—'],
    ['Referência informada', transaction.command?.referenceExternalTransactionId ?? 'sem referência'],
    ['Referência vinculada', transaction.referenceTransactionId ?? 'não vinculada'],
    ['Criada em', dateTime(transaction.createdAt)], ['Processada em', dateTime(transaction.processedAt)],
  ];
  const tone = transaction.status === 'PROCESSED' ? '' : transaction.status === 'PENDING_REFERENCE' ? 'waiting' : 'rejected';
  return <div className={`result ${tone}`} aria-live="polite">
    <p className="font-semibold">{statusText[transaction.status] ?? transaction.status} <span className="mono">({transaction.status})</span></p>
    {transaction.failureCode && <p>{failureMessage(transaction.failureCode)} <span className="mono">({transaction.failureCode})</span></p>}
    <dl className="result-grid">
      {rows.map(([label, value]) => <div key={label} className="contents"><dt>{label}</dt><dd className="break-all">{value}</dd></div>)}
      {transaction.result?.balance && <><dt>Saldo observado</dt><dd className="money">{transaction.result.balance.amount} {transaction.result.balance.currency}</dd></>}
      <dt>ID interno</dt><dd className="fact-id"><span className="mono break-all">{transaction.id}</span><CopyButton value={transaction.id} label="ID interno" /></dd>
    </dl>
  </div>;
}

export function TransactionLookup({ request }: Readonly<{ request: LookupRequest | null }>) {
  const [mode, setMode] = useState<Search['mode']>('external');
  const [id, setId] = useState('');
  const [providerId, setProviderId] = useState('provider-a');
  const [externalTransactionId, setExternalTransactionId] = useState('');
  const lookup = useMutation({ mutationFn: find, retry: false });
  const { mutate } = lookup;
  // "Consultar" do histórico ou do resultado preenche a busca e executa.
  useEffect(() => {
    if (!request) return;
    setMode('external'); setProviderId(request.providerId); setExternalTransactionId(request.externalTransactionId);
    mutate({ mode: 'external', providerId: request.providerId, externalTransactionId: request.externalTransactionId });
  }, [request, mutate]);
  const ready = mode === 'internal' ? id.trim() !== '' : providerId.trim() !== '' && externalTransactionId.trim() !== '';
  return <section className="panel">
    <Heading eyebrow="Estado gravado" title="Consultar transação" topic="lookup" />
    <form noValidate className="form-grid" onSubmit={(event) => {
      event.preventDefault();
      lookup.mutate(mode === 'internal' ? { mode, id: id.trim() } : { mode, providerId: providerId.trim(), externalTransactionId: externalTransactionId.trim() });
    }}>
      <fieldset className="col-span-full segmented">
        <legend className="sr-only">Buscar por</legend>
        <label><input type="radio" name="lookup-mode" checked={mode === 'external'} onChange={() => setMode('external')} />Provedor e ID externo</label>
        <label><input type="radio" name="lookup-mode" checked={mode === 'internal'} onChange={() => setMode('internal')} />ID interno</label>
      </fieldset>
      {mode === 'internal'
        ? <Field id="lookup-id" label="ID interno da transação" topic="lookup" className="col-span-full">
          <input id="lookup-id" value={id} onChange={(event) => setId(event.target.value)} spellCheck={false} /></Field>
        : <>
          <Field id="lookup-provider" label="Provedor" topic="provider"><input id="lookup-provider" value={providerId} onChange={(event) => setProviderId(event.target.value)} spellCheck={false} /></Field>
          <Field id="lookup-external" label="ID externo" topic="externalId"><input id="lookup-external" value={externalTransactionId} onChange={(event) => setExternalTransactionId(event.target.value)} spellCheck={false} /></Field>
        </>}
      <div className="col-span-full"><button type="submit" className="primary" disabled={!ready || lookup.isPending}>{lookup.isPending ? 'Consultando…' : 'Consultar'}</button></div>
    </form>
    {lookup.isError && <p role="alert" className="error mt-4">{errorMessage(lookup.error)}</p>}
    {lookup.data && <Details transaction={lookup.data} />}
  </section>;
}
