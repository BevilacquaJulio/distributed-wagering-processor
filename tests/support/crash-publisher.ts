import { readConfig } from '../../src/config';
import { connectDisposableDatabase } from './database';
import { testPublisher } from './outbox';
import { testSqs } from './sqs';

// Publisher de teste que morre abruptamente com o claim confirmado: antes do envio ou depois dele e antes de publishedAt.
const url = process.env.CRASH_EVENT_QUEUE_URL;
const point = process.env.CRASH_POINT;
if (!url || (point !== 'before-send' && point !== 'after-send')) throw new Error('CRASH_EVENT_QUEUE_URL and CRASH_POINT are required');

const orm = await connectDisposableDatabase(readConfig().DATABASE_URL);
const kill = async () => { process.kill(process.pid, 'SIGKILL'); };
const { publisher } = testPublisher(testSqs(), orm, url, { hooks: point === 'before-send' ? { beforeSend: kill } : { afterSend: kill } });
await publisher.publishOnce();
process.stdout.write('confirmed\n');
