export const loadSemDiffWorker = (): Promise<Worker> => import('./createSemDiffWorker').then((m) => m.createSemDiffWorker());
