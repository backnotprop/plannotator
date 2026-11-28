import { semDiffPoolSize, thisDevice } from './semDiffPoolSize';
import { createSemDiffWorkerPool } from './semDiffWorkerPool';

const loadOne = (): Promise<Worker> => import('./createSemDiffWorker').then((m) => m.createSemDiffWorker());

export const loadSemDiffWorker = (): Worker => createSemDiffWorkerPool({ createWorker: loadOne, size: semDiffPoolSize(thisDevice()) });
