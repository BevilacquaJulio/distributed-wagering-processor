import type { MikroORM } from '@mikro-orm/postgresql';

const READY_DEADLINE_MS = 20000;
// Abaixo do lock_timeout (3s) da aplicação: quem espera na barreira não pode estourar o timeout.
const BARRIER_DEADLINE_MS = 2000;
const POLL_INTERVAL_MS = 20;

export interface Instance {
  readonly url: string;
  stop(): Promise<void>;
  output(): string;
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const { port } = probe;
  await probe.stop(true);
  if (!port) throw new Error('No free port available');
  return port;
}

function collect(stream: ReadableStream<Uint8Array>, sink: string[]): void {
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) {
      sink.push(decoder.decode(chunk, { stream: true }));
      if (sink.length > 200) sink.shift();
    }
  })();
}

async function waitUntilReady(url: string, exited: () => boolean, output: () => string): Promise<void> {
  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (exited()) throw new Error(`API instance exited before readiness:\n${output()}`);
    try {
      const response = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* processo ainda subindo */ }
    await Bun.sleep(100);
  }
  throw new Error(`API instance not ready within ${READY_DEADLINE_MS}ms:\n${output()}`);
}

// Cada instância é um processo Bun separado, com pool próprio, apontando para o mesmo banco.
// --no-env-file impede que o .env de desenvolvimento substitua o banco descartável.
async function startInstance(databaseUrl: string): Promise<Instance> {
  const port = await freePort();
  const child = Bun.spawn([process.execPath, '--no-env-file', 'src/main.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl, HOST: '127.0.0.1', PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const lines: string[] = [];
  collect(child.stdout, lines);
  collect(child.stderr, lines);
  const url = `http://127.0.0.1:${port}`;
  const output = () => lines.join('');
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await child.exited;
    clearTimeout(timer);
  };
  try {
    await waitUntilReady(url, () => child.exitCode !== null, output);
  } catch (error) {
    await stop();
    throw error;
  }
  return { url, stop, output };
}

export async function startInstances(count: number, databaseUrl: string): Promise<Instance[]> {
  const started = await Promise.allSettled(Array.from({ length: count }, () => startInstance(databaseUrl)));
  const instances = started.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const failure = started.find((result) => result.status === 'rejected');
  if (failure) {
    await stopInstances(instances);
    throw failure.reason;
  }
  return instances;
}

export async function stopInstances(instances: readonly Instance[]): Promise<void> {
  await Promise.all(instances.map((instance) => instance.stop()));
}

export interface Barrier {
  release(): Promise<void>;
}

class ReleaseBarrier extends Error {}

// Mantém uma transação aberta segurando o recurso disputado até release(); rollback descarta o que ela gravou.
async function hold(orm: MikroORM, sql: string, params: unknown[], rollback: boolean): Promise<Barrier> {
  let open!: () => void;
  const released = new Promise<void>((resolve) => { open = resolve; });
  let acquired!: () => void;
  let failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
  let failure: unknown;
  const done = orm.em.fork().transactional(async (em) => {
    await em.execute(sql, params);
    acquired();
    await released;
    if (rollback) throw new ReleaseBarrier();
  }).catch((error: unknown) => {
    if (error instanceof ReleaseBarrier) return;
    failure = error;
    failed(error);
  });
  await ready;
  return {
    release: async () => {
      open();
      await done;
      if (failure) throw failure;
    },
  };
}

export function lockWallet(orm: MikroORM, walletId: string): Promise<Barrier> {
  return hold(orm, 'select id from wallets where id = ? for update', [walletId], false);
}

// Uma wallet provisória e não confirmada para o mesmo jogador faz todas as criações esperarem na unicidade.
export function holdWalletIdentity(orm: MikroORM, playerId: string): Promise<Barrier> {
  return hold(orm, `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
    values (gen_random_uuid(), ?, 'BRL', 0, 1, now(), now())`, [playerId], true);
}

// Condição observada no próprio PostgreSQL: transações das instâncias bloqueadas esperando lock.
export async function waitForLockWaiters(orm: MikroORM, expected: number): Promise<number> {
  const deadline = Date.now() + BARRIER_DEADLINE_MS;
  let waiting = 0;
  while (Date.now() < deadline) {
    const rows = await orm.em.fork().execute<{ waiting: number }[]>(`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`);
    waiting = rows[0]?.waiting ?? 0;
    if (waiting >= expected) return waiting;
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return waiting;
}
