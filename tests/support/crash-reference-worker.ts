import { readConfig } from '../../src/config';
import { connectDisposableDatabase } from './database';
import { testWorker } from './references';

// Worker de teste que morre abruptamente com a resolução já calculada e ainda não confirmada no banco.
const orm = await connectDisposableDatabase(readConfig().DATABASE_URL);
const { worker } = testWorker(orm, { batchSize: 1, beforeCommit: async () => { process.kill(process.pid, 'SIGKILL'); } });
await worker.runOnce();
process.stdout.write('committed\n');
