import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api, errorMessage, getWallet, type Wallet } from './api';
import { OperationForm } from './forms';
import { type SentOperation, SessionHistory } from './history';
import { Ledger } from './ledger';
import { type LookupRequest, TransactionLookup } from './lookup';
import { InfoButton, TabPanel, Tabs } from './ui';
import { readRecentWallets, rememberWallet, WalletSetup, WalletSummary } from './wallet';

type Tab = 'operate' | 'consult' | 'ledger';
const tabs = [{ id: 'operate', label: 'Operar' }, { id: 'consult', label: 'Consultar' }, { id: 'ledger', label: 'Extrato' }] as const;

function HealthStatus() {
  const health = useQuery({ queryKey: ['health'], queryFn: async () => z.object({ status: z.literal('up') }).parse((await api.get('/health/ready')).data), retry: false });
  const label = health.isFetching ? 'Consultando…' : health.isError ? 'API indisponível' : 'API disponível';
  return <span className="inline-flex items-center gap-1">
    <button type="button" className={`health ${health.isError ? 'offline' : ''}`} disabled={health.isFetching} onClick={() => void health.refetch()}
      aria-label={`${label}. Consultar de novo`}><span className="dot" aria-hidden="true" />{label}</button>
    <InfoButton topic="health" />
  </span>;
}

export default function App() {
  const client = useQueryClient();
  const [walletId, setWalletId] = useState('');
  const [recent, setRecent] = useState(readRecentWallets);
  const [tab, setTab] = useState<Tab>('operate');
  const [history, setHistory] = useState<SentOperation[]>([]);
  const [lookupRequest, setLookupRequest] = useState<LookupRequest | null>(null);
  const wallet = useQuery({ queryKey: ['wallet', walletId], queryFn: ({ signal }) => getWallet(walletId, signal), enabled: !!walletId });
  const walletData = wallet.data;
  const openedId = walletData?.id;
  const openedPlayer = walletData?.playerId;

  useEffect(() => {
    if (openedId && openedPlayer) setRecent(rememberWallet({ id: openedId, playerId: openedPlayer }));
  }, [openedId, openedPlayer]);

  const walletHistory = useMemo(() => history.filter((item) => item.walletId === walletId), [history, walletId]);
  const externalIds = useMemo(() => new Map(walletHistory.flatMap((item) =>
    item.result ? [[item.result.transactionId, item.fields.externalTransactionId] as const] : [])), [walletHistory]);

  function created(next: Wallet) { client.setQueryData(['wallet', next.id], next); setWalletId(next.id); setTab('operate'); }
  function lookup(providerId: string, externalTransactionId: string) {
    setLookupRequest({ providerId, externalTransactionId, nonce: Date.now() });
    setTab('consult');
  }

  return <div className="shell">
    <header className="topbar">
      <a href="/" className="brand"><span aria-hidden="true" className="brand-mark">J</span><span>JUNGLE<span className="brand-sub">PAINEL DE TESTES</span></span></a>
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1 text-sm font-medium">Como funciona<InfoButton topic="overview" /></span>
        <HealthStatus />
      </div>
    </header>
    <main className="space-y-5 pb-10">
      {!walletData && !(walletId && wallet.isPending) && <WalletSetup recent={recent} onCreated={created}
        onOpen={(id) => { setWalletId(id); setTab('operate'); }} error={wallet.isError ? errorMessage(wallet.error) : undefined} />}
      {walletId && wallet.isPending && <output className="block muted">Abrindo wallet…</output>}
      {walletData && <>
        <WalletSummary wallet={walletData} refreshing={wallet.isFetching} onRefresh={() => void wallet.refetch()} onChange={() => setWalletId('')} />
        {wallet.isError && <p role="alert" className="error">{errorMessage(wallet.error)}</p>}
        <Tabs<Tab> items={tabs} active={tab} onChange={setTab} label="Áreas do painel" />
        <TabPanel id="operate" active={tab === 'operate'}>
          <OperationForm key={walletData.id} wallet={walletData} history={walletHistory} onLookup={lookup}
            onSent={(operation) => setHistory((items) => [...items, { ...operation, seq: items.length + 1 }])}
            side={<SessionHistory items={walletHistory} onLookup={lookup} />} />
        </TabPanel>
        <TabPanel id="consult" active={tab === 'consult'}><TransactionLookup request={lookupRequest} /></TabPanel>
        <TabPanel id="ledger" active={tab === 'ledger'}><Ledger key={walletData.id} walletId={walletData.id} externalIds={externalIds} /></TabPanel>
      </>}
    </main>
  </div>;
}
