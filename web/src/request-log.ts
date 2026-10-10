import { useSyncExternalStore } from 'react';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';

export interface RequestRecord {
  id: number;
  label: string;
  at: string;
  method: string;
  /** URL completa como o navegador chamou, passando pelo proxy /api do painel. */
  url: string;
  /** Caminho na API, sem o prefixo /api do proxy. */
  path: string;
  headers: [string, string][];
  body: string | null;
  status: number | null;
  response: string | null;
}

const LIMIT = 20;
let records: RequestRecord[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function pretty(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

/** Registro só na memória desta aba: mostra o que o painel enviou para ser refeito no Postman. */
export function recordRequest(label: string, uri: string, config: InternalAxiosRequestConfig, response?: AxiosResponse) {
  // O cliente também roda fora do navegador (teste de integração do painel); lá não há location e a URI já é absoluta.
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin ?? 'http://localhost';
  const url = new URL(uri, origin);
  const body = pretty(config.data);
  const headers: [string, string][] = body ? [['Content-Type', 'application/json']] : [];
  const key = config.headers.get('Idempotency-Key');
  if (typeof key === 'string') headers.push(['Idempotency-Key', key]);
  records = [{
    id: nextId++, label, at: new Date().toISOString(), method: (config.method ?? 'get').toUpperCase(), url: url.toString(),
    path: `${url.pathname.replace(/^\/api(?=\/)/, '')}${url.search}`, headers, body,
    status: response?.status ?? null, response: pretty(response?.data),
  }, ...records].slice(0, LIMIT);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useRequestLog(): RequestRecord[] {
  return useSyncExternalStore(subscribe, () => records);
}
