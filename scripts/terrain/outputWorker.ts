// Worker thread for the terrain output stage. Receives tile keys, answers with
// {done: key} or {error: key, message}. Started by build-terrain.ts.

import { parentPort, workerData } from 'node:worker_threads';
import { writeOutput, type Dirs } from './output.ts';

const dirs = workerData as Dirs;

parentPort!.on('message', async (k: string) => {
  try {
    await writeOutput(k, dirs);
    parentPort!.postMessage({ done: k });
  } catch (e) {
    parentPort!.postMessage({ error: k, message: e instanceof Error ? e.stack : String(e) });
  }
});
