import { type ReactNode, useState } from 'react';
import { type RequestRecord, useRequestLog } from './request-log';
import { CopyButton, Heading } from './ui';

// Porta publicada da API no Compose e no README; o painel em si só conhece o proxy /api.
const DIRECT_API = 'http://127.0.0.1:3000';

const quote = (value: string) => `'${value.replaceAll("'", String.raw`'\''`)}'`;

function compact(body: string): string {
  try { return JSON.stringify(JSON.parse(body)); } catch { return body; }
}

function toCurl(record: RequestRecord): string {
  const parts = [`curl -X ${record.method} ${quote(record.url)}`, ...record.headers.map(([key, value]) => `-H ${quote(`${key}: ${value}`)}`)];
  if (record.body) parts.push(`--data-raw ${quote(compact(record.body))}`);
  return parts.join(' \\\n  ');
}

function parseBody(record: RequestRecord): Record<string, unknown> | null {
  if (!record.body) return null;
  try {
    const parsed: unknown = JSON.parse(record.body);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function responseStatus(response: string): string | undefined {
  try {
    const status: unknown = (JSON.parse(response) as { status?: unknown }).status;
    return typeof status === 'string' ? status : undefined;
  } catch { return undefined; }
}

function testsScript(record: RequestRecord): string {
  const lines = [`pm.test('HTTP ${record.status}', () => pm.response.to.have.status(${record.status}));`];
  const status = record.response ? responseStatus(record.response) : undefined;
  if (status && status !== 'up') {
    lines.push(`pm.test('status ${status}', () => pm.expect(pm.response.json().status).to.eql('${status}'));`);
  }
  return lines.join('\n');
}

function CodeBlock({ label, value }: Readonly<{ label: string; value: string }>) {
  return <div className="code-block">
    <div className="code-head"><span>{label}</span><CopyButton value={value} label={label} /></div>
    <pre>{value}</pre>
  </div>;
}

function Step({ n, title, where, children }: Readonly<{ n: number; title: string; where?: string; children: ReactNode }>) {
  return <li className="step">
    <span className="step-number" aria-hidden="true">{n}</span>
    <div className="min-w-0 flex-1 space-y-2">
      <h3>{title}{where && <span className="step-where">{where}</span>}</h3>
      {children}
    </div>
  </li>;
}

/** Como transformar a requisição registrada numa operação nova a cada Send, em vez de um replay. */
function RepeatStep({ record }: Readonly<{ record: RequestRecord }>) {
  const body = parseBody(record);
  if (record.path === '/wagering/transactions' && body) {
    const prefix = typeof body.kind === 'string' ? body.kind.toLowerCase() : 'op';
    const script = `// Gera um ID externo novo a cada Send; o body e o header usam a variável.\npm.variables.set('externalTransactionId', \`${prefix}-\${Date.now().toString(36)}\`);`;
    return <>
      <p>Enviar exatamente a requisição acima de novo é um <b>replay</b>: mesma chave, mesmo resultado, sem nova movimentação. Para cada
        Send virar uma operação nova, use o script, troque o valor do header e use o body com a variável:</p>
      <CodeBlock label="Pre-request" value={script} />
      <CodeBlock label="Valor do header Idempotency-Key" value="key-{{externalTransactionId}}" />
      <CodeBlock label="Body com variável" value={JSON.stringify({ ...body, externalTransactionId: '{{externalTransactionId}}' }, null, 2)} />
    </>;
  }
  if (record.method === 'POST' && record.path === '/wallets' && body) {
    return <>
      <p>Repetir o mesmo jogador dá 409 <code>WALLET_ALREADY_EXISTS</code>. Para criar uma wallet nova a cada Send, use o body abaixo:{' '}
        <code>{'{{$guid}}'}</code> é uma variável do Postman que gera um UUID novo. Não precisa de script.</p>
      <CodeBlock label="Body com jogador novo" value={JSON.stringify({ ...body, playerId: '{{$guid}}' }, null, 2)} />
    </>;
  }
  return <p className="muted">Não precisa de script: esta requisição pode ser repetida quantas vezes quiser sem efeito colateral.</p>;
}

function RequestGuide({ record }: Readonly<{ record: RequestRecord }>) {
  const directUrl = `${DIRECT_API}${record.path}`;
  return <div className="space-y-4 min-w-0">
    <div className="flex flex-wrap items-center gap-2">
      <span className="method-tag">{record.method}</span><strong>{record.label}</strong>
      <span className="muted text-xs">{new Date(record.at).toLocaleTimeString('pt-BR')}</span>
      <span className={`badge ${record.status && record.status < 400 ? 'badge-ok' : 'badge-error'}`}>{record.status ? `HTTP ${record.status}` : 'Sem resposta'}</span>
    </div>
    <ol className="steps">
      <Step n={1} title="Método e URL" where="barra de endereço do request">
        <p>Crie um request novo (<b>New → HTTP</b>), escolha <b>{record.method}</b> e cole a URL. As duas funcionam: a primeira passa pelo
          painel, a segunda vai direto na API.</p>
        <CodeBlock label="URL pelo painel" value={record.url} />
        <CodeBlock label="URL direta na API" value={directUrl} />
      </Step>
      <Step n={2} title="Headers" where="aba Headers">
        {record.headers.length === 0
          ? <p className="muted">Nenhum header extra.</p>
          : <>
            <table className="kv-table"><thead><tr><th>Key</th><th>Value</th></tr></thead>
              <tbody>{record.headers.map(([key, value]) => <tr key={key}><td className="mono">{key}</td>
                <td><span className="fact-id"><span className="mono break-all">{value}</span><CopyButton value={value} label={key} /></span></td></tr>)}</tbody></table>
            {record.body && <p className="muted text-xs">O Postman preenche Content-Type sozinho quando o body é raw JSON.</p>}
          </>}
      </Step>
      <Step n={3} title="Body" where="aba Body → raw → JSON">
        {record.body ? <CodeBlock label="Body" value={record.body} /> : <p className="muted">Sem body: requisição {record.method}.</p>}
      </Step>
      <Step n={4} title="Para enviar de novo" where="aba Scripts → Pre-request (opcional)"><RepeatStep record={record} /></Step>
      <Step n={5} title="Conferir a resposta" where="aba Scripts → Post-response (opcional)">
        {record.status
          ? <><p>Testes que conferem se o Postman recebeu o mesmo resultado que o painel recebeu:</p><CodeBlock label="Post-response" value={testsScript(record)} /></>
          : <p className="muted">Sem resposta registrada para comparar.</p>}
      </Step>
      <Step n={6} title="Resposta que o painel recebeu" where="compare com a aba Body da resposta">
        {record.response ? <CodeBlock label={`HTTP ${record.status}`} value={record.response} /> : <p className="muted">A API não respondeu.</p>}
      </Step>
      <Step n={7} title="Ou importe tudo de uma vez" where="Import → Raw text">
        <p>No Postman, <b>Import</b>, cole o cURL e confirme: método, URL, headers e body vêm preenchidos. Também serve para Insomnia e terminais.</p>
        <CodeBlock label="cURL" value={toCurl(record)} />
      </Step>
    </ol>
  </div>;
}

export function RequestsPanel() {
  const log = useRequestLog();
  const [selected, setSelected] = useState<number | null>(null);
  const current = log.find((record) => record.id === selected) ?? log[0];
  return <section className="panel">
    <Heading eyebrow="Para testar fora do painel" title="Últimas requisições" topic="requests" />
    {!current
      ? <p className="muted">Envie uma operação, consulte uma transação ou confira o saldo: cada chamada aparece aqui com o passo a passo para o Postman.</p>
      : <div className="requests-grid">
        <ol className="request-list" aria-label="Requisições desta sessão">{log.map((record) => <li key={record.id}>
          <button type="button" className="request-item" aria-current={record.id === current.id} onClick={() => setSelected(record.id)}>
            <span className="method-tag">{record.method}</span>
            <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{record.label}</span>
              <small className="truncate">{record.path}</small></span>
            <span className="muted text-xs">{record.status ?? '—'}</span>
          </button>
        </li>)}</ol>
        <RequestGuide record={current} />
      </div>}
  </section>;
}
