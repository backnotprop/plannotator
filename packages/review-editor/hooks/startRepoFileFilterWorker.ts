/// <reference path="../assets.d.ts" />

export async function startRepoFileFilterWorker(): Promise<Worker> {
  const { default: FilterWorker } = await import('./reviewFileFilter.worker?worker&inline');
  return new FilterWorker();
}
