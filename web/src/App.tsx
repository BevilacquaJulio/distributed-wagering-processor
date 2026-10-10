import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api, errorMessage, getLedger, getWallet, reconcile, type Wallet } from './api';
import { OperationForm, WalletForm } from './forms';
import { TransactionLookup } from './lookup';

function Ledger({ walletId }: { walletId: string }) {
  const ledger = useInfiniteQuery({ queryKey: ['ledger', walletId], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => getLedger(walletId, pageParam, signal), getNextPageParam: (page) => page.nextCursor });
  const reconciliation = useMutation({ mutationFn: () => reconcile(walletId), retry: false });
  const entries = ledger.data?.pages.flatMap((page) => page.entries) ?? [];
  return <section className="panel ledger-panel">
    <div className="section-heading"><div><p className="eyebrow">Histórico confirmado</p><h2>Ledger da wallet</h2></div>
      <button type="button" disabled={reconciliation.isPending || ledger.isFetching} onClick={() => reconciliation.mutate()}>Conferir saldo</button></div>
    {ledger.isPending && <output className="block">Carregando lançamentos…</output>}
    {ledger.isError && <p role="alert" className="error">{errorMessage(ledger.error)}</p>}
    {!ledger.isPending && !ledger.isError && entries.length === 0 && <p>Nenhum lançamento nesta wallet. Uma aposta processada aparecerá aqui.</p>}
    {entries.length > 0 && <div className="table-scroll"><table><thead><tr><th>Movimento</th><th>Valor · BRL</th><th>Saldo anterior</th><th>Saldo posterior</th><th>Transação</th></tr></thead>
      <tbody>{entries.map((entry) => <tr key={entry.id}><td><span className={`direction ${entry.direction.toLowerCase()}`}>{entry.direction === 'CREDIT' ? 'Crédito' : 'Débito'}</span><small>{new Date(entry.createdAt).toLocaleString('pt-BR')}</small></td>
        <td className="money">{entry.money.amount}</td><td className="money">{entry.balanceBefore.amount}</td><td className="money">{entry.balanceAfter.amount}</td><td className="mono transaction-id">{entry.transactionId}</td></tr>)}</tbody></table></div>}
    {ledger.hasNextPage && <button type="button" className="mt-4" disabled={ledger.isFetchingNextPage} onClick={() => void ledger.fetchNextPage()}>Carregar mais lançamentos</button>}
    {reconciliation.isError && <p className="error" role="alert">{errorMessage(reconciliation.error)}</p>}
    {reconciliation.data && <output className={`result block ${reconciliation.data.consistent ? '' : 'rejected'}`}><strong className="block">{reconciliation.data.consistent ? 'Saldo e histórico conferem' : 'Divergência identificada'}</strong>
      <span className="block">Armazenado: {reconciliation.data.storedBalance.amount} · Calculado: {reconciliation.data.calculatedBalance.amount} · Diferença: {reconciliation.data.difference.amount} BRL</span></output>}
  </section>;
}

export default function App() {
  const client = useQueryClient();
  const [walletId, setWalletId] = useState('');
  const [selection, setSelection] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const wallet = useQuery({ queryKey: ['wallet', walletId], queryFn: ({ signal }) => getWallet(walletId, signal), enabled: !!walletId });
  const health = useQuery({ queryKey: ['health'], queryFn: async () => z.object({ status: z.literal('up') }).parse((await api.get('/health/ready')).data), retry: false });
  function select(created: Wallet) { client.setQueryData(['wallet', created.id], created); setWalletId(created.id); setSelection(created.id); }
  return <div className="shell">
    <header className="topbar"><a href="/" className="brand"><span aria-hidden="true" className="brand-mark">J</span><span>JUNGLE<span className="brand-sub">GAMING · PAINEL DE TESTES</span></span></a>
      <button type="button" className={`health ${health.isError ? 'offline' : ''}`} disabled={health.isFetching} onClick={() => void health.refetch()}>{health.isFetching ? 'Consultando API…' : health.isError ? 'API indisponível · verificar' : 'API disponível · atualizar'}</button></header>
    <main>
      <div className="page-heading"><div><p className="eyebrow">Processador de apostas</p><h1>Da aposta ao extrato.</h1><p>Envie apostas, prêmios e reversões, confira o saldo e teste o reenvio.</p></div><span className="environment">Ambiente local</span></div>
      <div className="workspace">
        <aside className="panel wallet-tools"><p className="eyebrow">Comece pela wallet</p><h2>Criar wallet</h2><WalletForm onCreated={select} />
          <div className="divider" />
          <h3>Usar wallet existente</h3><form onSubmit={(event) => { event.preventDefault(); const parsed = z.string().uuid().safeParse(selection);
            if (!parsed.success) { setSelectionError('Informe um UUID válido.'); return; } setSelectionError(''); setWalletId(parsed.data); }}>
            <label>ID da wallet<input value={selection} onChange={(event) => setSelection(event.target.value)} /></label>
            {selectionError && <p role="alert" className="error">{selectionError}</p>}<button type="submit" className="w-full mt-3">Selecionar wallet</button></form>
        </aside>
        <div className="space-y-5 min-w-0">
          {!walletId && <section className="panel empty-wallet"><span className="empty-symbol" aria-hidden="true">↳</span><h2>Uma wallet para começar</h2><p>Crie uma wallet ou selecione uma existente para consultar o saldo e enviar a primeira operação.</p></section>}
          {walletId && wallet.isPending && <output className="panel block">Consultando wallet…</output>}
          {wallet.isError && <section className="panel error" role="alert">{errorMessage(wallet.error)} <button type="button" onClick={() => void wallet.refetch()}>Tentar novamente</button></section>}
          {wallet.data && !wallet.isError && <><section className="balance-panel"><div><p className="eyebrow">Saldo atual da wallet</p><p className="current-balance">{wallet.data.balance.amount}<span>{wallet.data.balance.currency}</span></p></div>
            <div className="wallet-meta"><span>Versão {wallet.data.version}</span><p className="mono break-all">{wallet.data.id}</p><button type="button" disabled={wallet.isFetching} onClick={() => void wallet.refetch()}>Atualizar saldo</button></div></section>
            <OperationForm key={wallet.data.id} wallet={wallet.data} /><TransactionLookup /><Ledger key={`ledger-${wallet.data.id}`} walletId={wallet.data.id} /></>}
        </div>
      </div>
    </main><footer>Jungle Gaming <span>Wallets, apostas e histórico financeiro.</span></footer>
  </div>;
}
