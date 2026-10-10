import { z } from 'zod';

const databaseUrl = z.string().url().refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol));
const runtimeSchema = z.object({
  DATABASE_URL: databaseUrl,
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  // Swagger em /docs; desligável onde a documentação não deve ser pública.
  API_DOCS_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
});

export type RuntimeConfig = z.infer<typeof runtimeSchema>;

export function readConfig(environment: Record<string, string | undefined> = process.env): RuntimeConfig {
  const parsed = runtimeSchema.safeParse(environment);
  if (!parsed.success) throw new Error(`Invalid environment keys: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  const url = new URL(parsed.data.DATABASE_URL);
  if (decodeURIComponent(url.username) !== 'jungle_runtime') throw new Error('DATABASE_URL must use jungle_runtime');
  return parsed.data;
}

const queueName = z.string().regex(/^[A-Za-z0-9_-]{1,75}\.fifo$/);
const messagingSchema = z.object({
  // Sem endpoint, o SDK usa o endpoint regional da AWS; localmente aponta para o emulador.
  SQS_ENDPOINT: z.string().url().optional(),
  SQS_REGION: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/).default('us-east-1'),
  SQS_COMMAND_QUEUE: queueName.default('wager-transactions.fifo'),
  SQS_DEAD_LETTER_QUEUE: queueName.default('wager-transactions-dlq.fifo'),
  SQS_CONSUMER_NAME: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).default('wager-transactions-consumer'),
  // Eventos de resultado ficam fora da fila de comandos para que nunca sejam consumidos como comandos.
  SQS_EVENT_QUEUE: queueName.default('wager-events.fifo'),
});

export type MessagingConfig = z.infer<typeof messagingSchema>;

export function readMessagingConfig(environment: Record<string, string | undefined> = process.env): MessagingConfig {
  const parsed = messagingSchema.safeParse(environment);
  if (!parsed.success) throw new Error(`Invalid environment keys: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  return parsed.data;
}

const metricsSchema = z.object({
  // Loopback por padrão; no Compose a porta fica só na rede interna, sem publicação no host.
  METRICS_HOST: z.string().min(1).default('127.0.0.1'),
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).optional(),
});

export interface MetricsConfig {
  readonly host: string;
  readonly port: number;
}

/** Cada processo tem porta padrão própria para rodarem juntos no host; 0 escolhe uma porta livre. */
export function readMetricsConfig(defaultPort: number, environment: Record<string, string | undefined> = process.env): MetricsConfig {
  const parsed = metricsSchema.safeParse(environment);
  if (!parsed.success) throw new Error(`Invalid environment keys: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  return { host: parsed.data.METRICS_HOST, port: parsed.data.METRICS_PORT ?? defaultPort };
}

export function adminUrl(): string {
  const result = databaseUrl.safeParse(process.env.DATABASE_ADMIN_URL);
  if (!result.success) throw new Error('DATABASE_ADMIN_URL is required');
  if (new URL(result.data).username === 'jungle_runtime') throw new Error('Migrations require an administrative role');
  return result.data;
}
