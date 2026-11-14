import type { SemanticDiffChange, SemanticDiffResponse, SemanticDiffUnreadFile } from '@plannotator/shared/semantic-diff-types';
import type { SemDiffClient } from './semDiffClient';
import { semDiffChanges } from './semDiffChanges';

export interface SemanticDiffSourceFile {
  path: string;
  oldPath?: string | null;
}

export type ReadFileContents = (
  file: SemanticDiffSourceFile,
  signal: AbortSignal,
) => Promise<{ oldContent: string | null; newContent: string | null } | null>;

type Source = (signal?: AbortSignal) => Promise<SemanticDiffResponse>;

const MAX_FILES = 400;
export const SEM_DIFF_MAX_CHARS = 2_000_000;
const CONCURRENCY = 3;

let source: Source | null = null;

export function setSemanticDiffSource(next: Source | null): void {
  source = next;
}

export function hasSemanticDiffSource(): boolean {
  return source !== null;
}

export async function loadReviewSemanticDiff(signal?: AbortSignal): Promise<SemanticDiffResponse> {
  if (source) return source(signal);
  const res = await fetch('/api/semantic-diff', { signal });
  if (!res.ok) throw new Error('Semantic diff failed');
  return res.json() as Promise<SemanticDiffResponse>;
}

export async function computeReviewSemanticDiff(
  files: readonly SemanticDiffSourceFile[],
  client: SemDiffClient,
  read: ReadFileContents,
  signal: AbortSignal,
  generated: ReadonlySet<string> = new Set(),
): Promise<SemanticDiffResponse> {
  const supported = files.filter((file) => client.supports(file.path)).slice(0, MAX_FILES);
  const unread: SemanticDiffUnreadFile[] = supported.filter((file) => generated.has(file.path)).map((file) => ({ path: file.path, reason: 'generated' }));
  const targets = supported.filter((file) => !generated.has(file.path));
  const perFile: SemanticDiffChange[][] = targets.map(() => []);
  let next = 0;
  const work = async () => {
    while (next < targets.length && !signal.aborted) {
      const index = next++;
      const file = targets[index]!;
      const contents = await read(file, signal).catch(() => null);
      if (signal.aborted) return;
      if (!contents) {
        unread.push({ path: file.path, reason: 'unreadable' });
        continue;
      }
      if (contents.oldContent == null || contents.newContent == null) continue;
      if (contents.oldContent.length + contents.newContent.length > SEM_DIFF_MAX_CHARS) {
        unread.push({ path: file.path, reason: 'too-large' });
        continue;
      }
      const outcome = await client.attempt(file.path, contents.oldContent, contents.newContent, signal);
      if (outcome.failed) unread.push({ path: file.path, reason: 'timed-out' });
      if (!outcome.result) continue;
      perFile[index] = semDiffChanges(file.path, outcome.result.semanticOperations, contents.oldContent, contents.newContent, file.oldPath ?? null);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));
  const changes = perFile.flat();
  const count = (type: string) => changes.filter((change) => change.changeType === type).length;
  return {
    status: 'ok',
    summary: {
      fileCount: perFile.filter((list) => list.length > 0).length,
      added: count('added'),
      modified: count('modified'),
      deleted: count('deleted'),
      moved: count('moved'),
      renamed: count('renamed'),
      reordered: count('reordered'),
      binary: 0,
      orphan: 0,
      total: changes.length,
    },
    changes,
    binaryChanges: [],
    semVersion: 'built-in',
    semSource: 'sem-diff',
    ...(unread.length > 0 && { unreadFiles: unread }),
  };
}
