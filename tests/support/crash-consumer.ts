import { readConfig } from '../../src/config';
import { connectDisposableDatabase } from './database';
import { receiveOne, testConsumer, testSqs } from './sqs';

// Processo de teste que morre abruptamente depois do commit e antes do ack, como um worker derrubado no meio da entrega.
const url = process.env.CRASH_QUEUE_URL;
const deadLetterUrl = process.env.CRASH_DEAD_LETTER_URL;
if (!url || !deadLetterUrl) throw new Error('CRASH_QUEUE_URL and CRASH_DEAD_LETTER_URL are required');

const orm = await connectDisposableDatabase(readConfig().DATABASE_URL);
const sqs = testSqs();
const consumer = testConsumer(sqs, orm, { url, deadLetterUrl, remove: async () => {} }, {
  afterCommit: async () => { process.kill(process.pid, 'SIGKILL'); },
});
await consumer.handle(await receiveOne(sqs, url));
process.stdout.write('acked\n');
