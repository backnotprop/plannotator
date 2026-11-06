import type { DiffFile } from '@plannotator/core/diff-files';
import type { InboxFileContents } from '@plannotator/core/inbox-types';

export type KeptWholeFiles = Map<string, { patch: string; contents: InboxFileContents }>;

/**
 * Asks a host for a changed file's whole text, for the viewer's arrows. A viewer mounted again asks again, so what this
 * patch already has is kept in `kept`; "there is none" and a failure are not, so a later click reads again. A failure
 * throws, so the viewer keeps its arrows for that click.
 */
export function wholeFileReader(read: (path: string, signal: AbortSignal, patch: string) => Promise<InboxFileContents>, kept: KeptWholeFiles) {
  return async (file: DiffFile, signal: AbortSignal): Promise<InboxFileContents | null> => {
    // Only a file with both sides has anything to open: an added or deleted one is already whole.
    if (file.status !== 'modified' && file.status !== 'renamed') return null;
    const held = kept.get(file.path);
    if (held?.patch === file.patch) return held.contents;
    const contents = await read(file.path, signal, file.patch);
    if (contents.failed) throw new Error(`Could not read ${file.path}.`);
    if (contents.oldContent !== null && contents.newContent !== null) kept.set(file.path, { patch: file.patch, contents });
    return contents;
  };
}
