import type { DiffFile } from '@plannotator/core/diff-files';
import type { InboxFileContents } from '@plannotator/core/inbox-types';

export type KeptWholeFiles = Map<string, { patch: string; contents: InboxFileContents }>;

export function wholeFileReader(read: (path: string, signal: AbortSignal, patch: string) => Promise<InboxFileContents>, kept: KeptWholeFiles) {
  return async (file: DiffFile, signal: AbortSignal): Promise<InboxFileContents | null> => {
    if (file.status !== 'modified' && file.status !== 'renamed') return null;
    const held = kept.get(file.path);
    if (held?.patch === file.patch) return held.contents;
    const contents = await read(file.path, signal, file.patch);
    if (contents.failed) throw new Error(`Could not read ${file.path}.`);
    if (contents.oldContent !== null && contents.newContent !== null) kept.set(file.path, { patch: file.patch, contents });
    return contents;
  };
}
