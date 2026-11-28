import type { DiffFile } from '@plannotator/core/diff-files';
import type { InboxFileContents } from '@plannotator/core/inbox-types';

export type KeptWholeFiles = Map<string, { patch: string; contents: InboxFileContents }>;

/**
 * Asks a host for a changed file's whole text, for the viewer's arrows. A viewer mounted again asks again, so what this
 * patch already has is kept in `kept`; "there is none" and a failure are not, so a later click reads again. A failure
 * throws, so the viewer keeps its arrows for that click.
 */
export const BACKGROUND_READS_AT_ONCE = 2;
export const BACKGROUND_READ_MS = 30_000;

export function wholeFileReader(read: (path: string, signal: AbortSignal, patch: string) => Promise<InboxFileContents>, kept: KeptWholeFiles, backgroundMs = BACKGROUND_READ_MS) {
  let running = 0;
  const waiting: Array<() => void> = [];
  const turn = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (running < BACKGROUND_READS_AT_ONCE) {
        running++;
        resolve();
        return;
      }
      const go = () => {
        signal.removeEventListener('abort', drop);
        running++;
        resolve();
      };
      const drop = () => {
        waiting.splice(waiting.indexOf(go), 1);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      waiting.push(go);
      signal.addEventListener('abort', drop, { once: true });
    });
  const done = () => {
    running--;
    waiting.shift()?.();
  };
  return async (file: DiffFile, signal: AbortSignal, how?: { background?: boolean }): Promise<InboxFileContents | null> => {
    // Only a file with both sides has anything to open: an added or deleted one is already whole.
    if (file.status !== 'modified' && file.status !== 'renamed') return null;
    const held = kept.get(file.path);
    if (held?.patch === file.patch) return held.contents;
    if (how?.background) await turn(signal);
    let contents: InboxFileContents;
    const limit = how?.background ? new AbortController() : null;
    const onAbort = () => limit?.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      contents = limit
        ? await Promise.race([
            read(file.path, limit.signal, file.patch),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                const late = new DOMException(`Reading ${file.path} took too long.`, 'TimeoutError');
                limit.abort(late);
                reject(late);
              }, backgroundMs);
            }),
          ])
        : await read(file.path, signal, file.patch);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (how?.background) done();
    }
    if (contents.failed) throw new Error(`Could not read ${file.path}.`);
    if (contents.oldContent !== null && contents.newContent !== null) kept.set(file.path, { patch: file.patch, contents });
    return contents;
  };
}
