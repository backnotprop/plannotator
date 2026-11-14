import { useEffect, useState } from 'react';

export type OriginalFileText =
  | { status: 'loading' }
  | { status: 'ready'; content: string }
  | { status: 'none'; message: string }
  | { status: 'error'; message: string };

export function useOriginalFileText(
  path: string,
  oldPath: string | undefined,
  base: string | undefined,
  snapshotId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): OriginalFileText {
  const [state, setState] = useState<OriginalFileText>({ status: 'loading' });
  useEffect(() => {
    setState({ status: 'loading' });
    const controller = new AbortController();
    const params = new URLSearchParams({ path });
    if (oldPath) params.set('oldPath', oldPath);
    if (base) params.set('base', base);
    if (snapshotId) params.set('snapshot', snapshotId);
    fetchImpl(`/api/file-content?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as { oldContent?: string | null; error?: string };
        if (controller.signal.aborted) return;
        if (!response.ok) setState({ status: 'error', message: body.error ?? `HTTP ${response.status}` });
        else if (typeof body.oldContent === 'string') setState({ status: 'ready', content: body.oldContent });
        else setState({ status: 'none', message: 'This file is new: it has no original.' });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', message: error instanceof Error ? error.message : 'The original could not be read.' });
      });
    return () => controller.abort();
  }, [path, oldPath, base, snapshotId, fetchImpl]);
  return state;
}
