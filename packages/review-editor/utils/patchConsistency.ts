/**
 * Guard against augmenting a diff with STALE file contents.
 *
 * The review session captures its patch once (at launch / diff switch), but
 * `/api/file-content` reads the file as it is NOW. The two can drift — e.g.
 * an agent edits or commits a file while the user is mid-review. Feeding
 * `processFile` a patch plus contents that no longer correspond produces a
 * FileDiffMetadata whose hunk/context line math is internally inconsistent;
 * Pierre's virtualization then fails layout estimation for the file
 * ("trailing context mismatch" console errors, disappearing content while
 * scrolling). Rendering the raw patch (no expand-context for that file) is
 * the correct degradation.
 *
 * The check: the patch's hunk headers fully determine the expected line-count
 * delta between the old and new file. If the fetched contents' totals don't
 * reconcile with that delta, the contents are stale relative to the patch.
 * (Same-length edits slip through, but those cannot break the count math —
 * worst case is a few wrong context lines until the next diff refresh.)
 */

const HUNK_HEADER_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm;

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const segments = content.split('\n').length;
  // A trailing newline does not start an extra line (git semantics).
  return content.endsWith('\n') ? segments - 1 : segments;
}

export function isContentConsistentWithPatch(
  patch: string,
  oldContent: string | null,
  newContent: string | null,
): boolean {
  // Only the both-sides case is verifiable from totals alone. One-sided
  // fetches (added / deleted files) pass through — processFile receives a
  // single file there and cannot produce a two-sided context mismatch.
  if (oldContent == null || newContent == null) return true;

  let net = 0;
  let sawHunk = false;
  for (const match of patch.matchAll(HUNK_HEADER_RE)) {
    sawHunk = true;
    const oldCount = match[1] != null ? Number(match[1]) : 1;
    const newCount = match[2] != null ? Number(match[2]) : 1;
    net += newCount - oldCount;
  }
  // No hunks → nothing to reconcile against (binary / metadata-only patch).
  if (!sawHunk) return true;

  return countLines(newContent) - countLines(oldContent) === net;
}
