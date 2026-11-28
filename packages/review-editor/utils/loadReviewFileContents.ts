import type { WholeFileText } from './wholeFileText';

interface FileContentResult {
  status: number;
  contents: WholeFileText | null;
}

interface PendingRequest {
  controller: AbortController;
  result: Promise<FileContentResult>;
  readers: number;
}

const pending = new Map<string, PendingRequest>();

/** Share overlapping reads only. A later read can see a changed working tree. */
export async function loadReviewFileContents(
  path: string,
  oldPath: string | null | undefined,
  base: string | undefined,
  snapshot: string | undefined,
  signal: AbortSignal,
): Promise<FileContentResult> {
  signal.throwIfAborted();
  const params = new URLSearchParams({ path });
  if (oldPath) params.set('oldPath', oldPath);
  if (base) params.set('base', base);
  if (snapshot) params.set('snapshot', snapshot);
  const url = `/api/file-content?${params}`;
  let request = pending.get(url);
  if (!request) {
    const controller = new AbortController();
    const entry: PendingRequest = {
      controller,
      readers: 0,
      result: fetch(url, { signal: controller.signal }).then(async (res) => ({
        status: res.status,
        contents: res.ok ? await res.json() : null,
      })).finally(() => {
        if (pending.get(url) === entry) pending.delete(url);
      }),
    };
    pending.set(url, entry);
    request = entry;
  }
  const entry = request;
  entry.readers++;
  return new Promise<FileContentResult>((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      signal.removeEventListener('abort', abort);
      entry.readers--;
      return true;
    };
    const abort = () => {
      if (!finish()) return;
      if (entry.readers === 0 && pending.get(url) === entry) {
        pending.delete(url);
        entry.controller.abort();
      }
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void entry.result.then(
      (data) => { if (finish()) resolve(data); },
      (error) => { if (finish()) reject(error); },
    );
  });
}
