import type { OperationInput, WagerResult } from './api';
import { CopyButton, Heading } from './ui';

export interface SentOperation {
  seq: number;
  walletId: string;
  fields: OperationInput;
  at: string;
  replay: boolean;
  result?: WagerResult | undefined;
  error?: string | undefined;
}

export const statusLabels: Record<WagerResult['status'], string> = {
  PROCESSED: 'Processada', REJECTED: 'Rejeitada', PENDING: 'Pendente', PENDING_REFERENCE: 'Aguardando referência',
};

export function StatusBadge({ operation }: Readonly<{ operation: Pick<SentOperation, 'result' | 'error'> }>) {
  if (!operation.result) return <span className="badge badge-error">Não concluída</span>;
  const tone = { PROCESSED: 'badge-ok', REJECTED: 'badge-error', PENDING: 'badge-wait', PENDING_REFERENCE: 'badge-wait' }[operation.result.status];
  return <span className={`badge ${tone}`}>{statusLabels[operation.result.status]}</span>;
}

export function SessionHistory({ items, onLookup }: Readonly<{ items: SentOperation[]; onLookup(providerId: string, externalId: string): void }>) {
  return <section className="panel">
    <Heading eyebrow="Nesta aba" title="Enviadas nesta sessão" topic="history" />
    {items.length === 0
      ? <p className="muted">As operações que você enviar aparecem aqui, com o ID externo pronto para copiar ou referenciar.</p>
      : <ol className="history-list">{[...items].reverse().map((item) => <li key={item.seq} className="history-item">
        <div className="history-main">
          <span className="kind-tag">{item.fields.kind}</span>
          <span className="money">{item.fields.amount}</span>
          <StatusBadge operation={item} />
          {item.replay && <span className="badge badge-neutral">Reenvio</span>}
        </div>
        <div className="history-id">
          <span className="mono truncate" title={item.fields.externalTransactionId}>{item.fields.externalTransactionId}</span>
          <CopyButton value={item.fields.externalTransactionId} label={`ID externo de ${item.fields.kind}`} />
          <button type="button" className="text-button" onClick={() => onLookup(item.fields.providerId, item.fields.externalTransactionId)}>Consultar</button>
        </div>
        {item.fields.reference && <small>Referência: <span className="mono">{item.fields.reference}</span></small>}
      </li>)}</ol>}
  </section>;
}
