import { parseDiffToFiles, type DiffFile } from "@plannotator/core/diff-files";

/**
 * A pull request diff's changed files, parsed once per diff answer. `GET /api/inbox/pulls/file` checks that the file it
 * reads is one the diff changes, and the PR page asks it once per changed file as the files near the viewport (their
 * length, for the row after the last hunk), so the whole patch is not parsed again for every file. Keyed by the answer
 * object: `pulls.diff` hands back the same one while it keeps that diff (by PR, scope, base and head, bounded there), so
 * this holds no more than that cache does, and a new head is a new answer, parsed afresh.
 */
const parsed = new WeakMap<object, Map<string, DiffFile>>();

/** The first changed file at `path` in this diff answer's patch, as `parseDiffToFiles(patch).find(...)` gives it. */
export function changedFileOf(answer: { readonly patch: string }, path: string): DiffFile | undefined {
  let files = parsed.get(answer);
  if (!files) {
    files = new Map();
    for (const file of parseDiffToFiles(answer.patch)) if (!files.has(file.path)) files.set(file.path, file);
    parsed.set(answer, files);
  }
  return files.get(path);
}
