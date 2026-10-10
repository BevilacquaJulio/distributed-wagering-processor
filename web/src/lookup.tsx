import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { errorMessage, failureMessage, getTransaction, getTransactionByExternal, type TransactionView } from './api';

type Search = { mode: 'internal'; id: string } | { mode: 'external'; providerId: string; externalTransactionId: string };

function find(search: Search): Promise<TransactionView> {
  return search.mode === 'internal' ? getTransaction(search.id) : getTransactionByExternal(search.providerId, search.externalTransactionId);
}

function Details({ transaction }: Readonly<{ transaction: TransactionView }>) {
  const rows: [string, string][] = [
    ['Tipo', transaction.kind], ['Status atual', transaction.status], ['Valor', `${transaction.money.amount} ${transaction.money.currency}`],
    ['ID externo', transaction.command?.externalTransactionId ?? 'abertura interna'],
    ['Referência', transaction.command?.referenceExternalTransactionId ?? 'sem referência'],
    ['Referência vinculada', transaction.referenceTransactionId ?? 'não vinculada'],
  ];
  return <div className={`result ${transaction.status === 'REJECTED' ? 'rejected' : ''}`} aria-live="polite">
    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
      {rows.map(([label, value]) => <div key={label} className="contents"><dt className="font-semibold">{label}</dt><dd className="break-all">{value}</dd></div>)}
    </dl>
    {transaction.failureCode && <p>{failureMessage(transaction.failureCode)}</p>}
    {transaction.result?.balance && <p>Saldo observado quando a resposta foi gravada: <b className="money">
      {transaction.result.balance.amount} {transaction.result.balance.currency}</b> ({transaction.result.status})</p>}
    <p className="mono break-all">{transaction.id}</p>
  </div>;
}

export function TransactionLookup() {
  const [mode, setMode] = useState<Search['mode']>('external');
  const [id, setId] = useState('');
  const [providerId, setProviderId] = useState('provider-a');
  const [externalTransactionId, setExternalTransactionId] = useState('');
  const lookup = useMutation({ mutationFn: find, retry: false });
  const ready = mode === 'internal' ? id.trim() !== '' : providerId.trim() !== '' && externalTransactionId.trim() !== '';
  return <section className="panel">
    <div className="section-heading"><div><p className="eyebrow">Estado persistido</p><h2>Consultar transação</h2></div></div>
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={(event) => {
      event.preventDefault();
      lookup.mutate(mode === 'internal' ? { mode, id: id.trim() } : { mode, providerId: providerId.trim(), externalTransactionId: externalTransactionId.trim() });
    }}>
      <fieldset className="sm:col-span-2 flex flex-wrap gap-4">
        <legend className="sr-only">Buscar por</legend>
        <label className="flex items-center gap-2"><input type="radio" name="lookup-mode" checked={mode === 'external'} onChange={() => setMode('external')} />Provedor e ID externo</label>
        <label className="flex items-center gap-2"><input type="radio" name="lookup-mode" checked={mode === 'internal'} onChange={() => setMode('internal')} />ID interno</label>
      </fieldset>
      {mode === 'internal'
        ? <label className="sm:col-span-2">ID interno da transação<input value={id} onChange={(event) => setId(event.target.value)} /></label>
        : <><label>Provedor<input value={providerId} onChange={(event) => setProviderId(event.target.value)} /></label>
          <label>ID externo<input value={externalTransactionId} onChange={(event) => setExternalTransactionId(event.target.value)} /></label></>}
      <div className="sm:col-span-2"><button type="submit" disabled={!ready || lookup.isPending}>{lookup.isPending ? 'Consultando…' : 'Consultar'}</button></div>
    </form>
    {lookup.isError && <p role="alert" className="error mt-4">{errorMessage(lookup.error)}</p>}
    {lookup.data && <Details transaction={lookup.data} />}
  </section>;
}
