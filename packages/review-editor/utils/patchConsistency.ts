const HUNK_HEADER_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm;

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const segments = content.split('\n').length;
  return content.endsWith('\n') ? segments - 1 : segments;
}

export function isContentConsistentWithPatch(
  patch: string,
  oldContent: string | null,
  newContent: string | null,
): boolean {
  if (oldContent == null || newContent == null) return true;

  let net = 0;
  let sawHunk = false;
  for (const match of patch.matchAll(HUNK_HEADER_RE)) {
    sawHunk = true;
    const oldCount = match[1] != null ? Number(match[1]) : 1;
    const newCount = match[2] != null ? Number(match[2]) : 1;
    net += newCount - oldCount;
  }
  if (!sawHunk) return true;

  return countLines(newContent) - countLines(oldContent) === net;
}
