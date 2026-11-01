/**
 * The art worker for the Inbox's single-file page: Vite inlines the worker
 * (@plannotator/ui/art/art.worker.ts) as a blob, which the window's CSP allows
 * (`worker-src 'self' blob:`). Imported lazily by art.tsx, only when a
 * background draws, so the bun tests (which have no worker) never load it.
 */
// @ts-expect-error vite ?worker&inline virtual module (no ambient types here)
import ArtWorker from '@plannotator/ui/art/art.worker.ts?worker&inline';

export function startArtWorker(): Worker {
  return new (ArtWorker as new (options?: { name?: string }) => Worker)({ name: 'art' });
}
