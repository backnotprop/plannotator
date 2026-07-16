/**
 * Parse output of `gh api --paginate` / `glab api --paginate`.
 *
 * Both CLIs concatenate pages as adjacent JSON arrays (`[...][...]`) which is
 * not valid JSON. Walk the output, split it into top-level arrays, and merge
 * them. Single-page output (the common case) round-trips through the same path.
 */
export function parsePaginatedArray<T>(stdout: string): T[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const slices: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "[" || c === "{") {
      if (depth === 0 && c === "[") start = i;
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0 && c === "]" && start !== -1) {
        slices.push(trimmed.slice(start, i + 1));
        start = -1;
      }
    }
  }

  if (slices.length === 0) {
    return JSON.parse(trimmed) as T[];
  }

  const merged: T[] = [];
  for (const slice of slices) {
    const page = JSON.parse(slice) as T[];
    if (Array.isArray(page)) merged.push(...page);
  }
  return merged;
}
