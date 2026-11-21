// @ts-expect-error vite ?worker&inline virtual module (no ambient types here)
import SemDiffWorker from './semDiffWorker.ts?worker&inline';

export function createSemDiffWorker(): Worker {
  return new SemDiffWorker() as Worker;
}
