import type { CodeNavLocation } from '@plannotator/shared/code-nav';

/**
 * The one definition a jump goes to (F12, and a Cmd/Ctrl-click on a token):
 * the definitions told apart by file and line, when exactly one is left. With
 * `from` (a click), a definition at the clicked line is the token itself, so
 * there is nowhere to jump: null, and the click opens References instead.
 */
export function oneDefinition(definitions: readonly CodeNavLocation[], from?: { filePath: string; line: number }): CodeNavLocation | null {
  const distinct = [...new Map(definitions.map((d) => [`${d.filePath}:${d.line}`, d])).values()];
  if (distinct.length !== 1) return null;
  const only = distinct[0]!;
  return from && only.filePath === from.filePath && only.line === from.line ? null : only;
}
