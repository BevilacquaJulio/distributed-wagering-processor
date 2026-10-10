import { createHash, randomUUID } from 'node:crypto';
import type { Clock, IdGenerator, PayloadHasher, ProviderIdentityPort } from '../application/ports';

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    // Campo ausente e campo undefined produzem o mesmo hash: a referência omitida não entra no payload.
    const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  throw new Error('Payload must be JSON serializable');
}

export class Sha256PayloadHasher implements PayloadHasher {
  hash(value: unknown): string { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }
}

export class SystemClock implements Clock { now(): string { return new Date().toISOString(); } }
export class UuidGenerator implements IdGenerator { next(): string { return randomUUID(); } }

// The case defers external authentication; replace this port with the provider's IdP adapter.
export class UnauthenticatedProviderIdentity implements ProviderIdentityPort {
  async assertProvider(_providerId: string): Promise<void> {}
}
