import { createApplication } from './bootstrap';
import { readConfig } from './config';
import { logEvent } from './infrastructure/observability';
import type { NestExpressApplication } from '@nestjs/platform-express';

let application: NestExpressApplication | undefined;
try {
  const config = readConfig();
  application = await createApplication(config);
  await application.listen(config.PORT, config.HOST);
  logEvent('http_listening', { port: config.PORT, scope: 'http-bet' });
} catch {
  await application?.close();
  logEvent('startup_failed', { message: 'Check environment, database role and connectivity.' });
  process.exitCode = 1;
}
