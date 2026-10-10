import { createApplication } from './bootstrap';
import { readConfig, readMessagingConfig } from './config';
import { logEvent } from './infrastructure/observability';
import type { NestExpressApplication } from '@nestjs/platform-express';

let application: NestExpressApplication | undefined;
try {
  const config = readConfig();
  application = await createApplication(config, readMessagingConfig());
  await application.listen(config.PORT, config.HOST);
  logEvent('http_listening', { port: config.PORT });
} catch {
  await application?.close();
  logEvent('startup_failed', { message: 'Check environment, database role and connectivity.' });
  process.exitCode = 1;
}
