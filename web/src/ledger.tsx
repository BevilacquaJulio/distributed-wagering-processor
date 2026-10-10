import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { errorMessage, getLedger, reconcile } from './api';
import { Heading, InfoButton } from './ui';

export function Ledger({ walletId, externalIds }: Readonly<{ walletId: string; externalIds: ReadonlyMap<string, string> }>) {
  const ledger = useInfiniteQuery({ queryKey: ['ledger', walletId], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => getLedger(walletId, pageParam, signal), getNextPageParam: (page) => page.nextCursor });
  const reconciliation = useMutation({ mutationFn: () => reconcile(walletId), retry: false });
  const entries = ledger.data?.pages.flatMap((page) => page.entries) ?? [];
  return <section className="panel">
    <Heading eyebrow="Histórico confirmado" title="Ledger da wallet" topic="ledger">
      <span className="inline-flex items-center gap-1">
        <button type="button" disabled={reconciliation.isPending || ledger.isFetching} onClick={() => reconciliation.mutate()}>
          {reconciliation.isPending ? 'Conferindo…' : 'Conferir saldo'}</button>
        <InfoButton topic="reconciliation" />
      </span>
    </Heading>
    {reconciliation.isError && <p className="error" role="alert">{errorMessage(reconciliation.error)}</p>}
    {reconciliation.data && <output className={`result block mb-5 ${reconciliation.data.consistent ? '' : 'rejected'}`}>
      <strong className="block">{reconciliation.data.consistent ? 'Saldo e histórico conferem' : 'Divergência identificada'}</strong>
      <span className="block">Armazenado: {reconciliation.data.storedBalance.amount} · Calculado pelo ledger: {reconciliation.data.calculatedBalance.amount} · Diferença: {reconciliation.data.difference.amount} BRL</span>
    </output>}
    {ledger.isPending && <output className="block muted">Carregando lançamentos…</output>}
    {ledger.isError && <p role="alert" className="error">{errorMessage(ledger.error)}</p>}
    {!ledger.isPending && !ledger.isError && entries.length === 0 && <p className="muted">Nenhum lançamento nesta wallet. Uma operação processada que movimenta saldo aparecerá aqui.</p>}
    {entries.length > 0 && <div className="table-scroll"><table>
      <thead><tr><th>Movimento</th><th className="text-right">Valor</th><th className="text-right">Saldo anterior</th><th className="text-right">Saldo posterior</th><th>Transação</th></tr></thead>
      <tbody>{entries.map((entry) => {
        const external = externalIds.get(entry.transactionId);
        return <tr key={entry.id}>
          <td><span className={`direction ${entry.direction.toLowerCase()}`}>{entry.direction === 'CREDIT' ? 'Crédito' : 'Débito'}</span><small>{new Date(entry.createdAt).toLocaleString('pt-BR')}</small></td>
          <td className="money text-right">{entry.direction === 'CREDIT' ? '+' : '−'}{entry.money.amount}</td>
          <td className="money text-right">{entry.balanceBefore.amount}</td>
          <td className="money text-right">{entry.balanceAfter.amount}</td>
          <td className="mono">{external ?? <span className="muted" title={entry.transactionId}>interno {entry.transactionId.slice(0, 8)}…</span>}</td>
        </tr>;
      })}</tbody>
    </table></div>}
    {ledger.hasNextPage && <button type="button" className="mt-4" disabled={ledger.isFetchingNextPage} onClick={() => void ledger.fetchNextPage()}>
      {ledger.isFetchingNextPage ? 'Carregando…' : 'Carregar mais lançamentos'}</button>}
  </section>;
}
