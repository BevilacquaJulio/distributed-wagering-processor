import { type Gauge, logEvent, type Metrics } from './observability';

export interface MetricsServer {
  readonly port: number;
  stop(): Promise<void>;
}

/**
 * HTTP mínimo dos processos sem API: /metrics e /health/live. Não expõe dados financeiros nem aceita escrita.
 * Gauges são lidos a cada coleta; falha na leitura não derruba o endpoint.
 */
export function startMetricsServer(metrics: Metrics, host: string, port: number,
  gauges: () => Promise<readonly Gauge[]> = async () => []): MetricsServer {
  const server = Bun.serve({
    hostname: host, port,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
      if (pathname === '/health/live') return Response.json({ status: 'up' });
      if (pathname !== '/metrics') return new Response('Not Found', { status: 404 });
      let current: readonly Gauge[] = [];
      try {
        current = await gauges();
      } catch (error) {
        logEvent('metrics_gauge_failed', { error: error instanceof Error ? error.name : 'unknown' });
      }
      return new Response(metrics.render(current), { headers: { 'Content-Type': 'text/plain; version=0.0.4' } });
    },
  });
  logEvent('metrics_server_started', { port: server.port ?? port });
  return { port: server.port ?? port, stop: async () => { await server.stop(true); } };
}
