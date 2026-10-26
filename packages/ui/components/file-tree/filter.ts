/**
 * The tree's filter, with FileBrowser's rules (sidebar/FileBrowser.tsx,
 * `getFileTreeFilterTokens` + `filterFileTree`): the query splits on spaces,
 * backslashes read as `/`, case is ignored, and a node matches when every
 * token appears in "name displayName path". A file shows when it or any folder
 * above it matches (a matching folder shows everything under it).
 */
import { normalizeTreePath } from './model';

function normalizeFilterText(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

export function treeFilterTokens(query: string): string[] {
  return normalizeFilterText(query).trim().split(/\s+/).filter(Boolean);
}

/**
 * The listed paths (as `FileTreeModel.listedPaths()` returns them) that the
 * filter keeps. `displayName` is the name the row shows, which FileBrowser
 * also matches on (it strips `.md`, `.txt`, `.html`).
 */
export function filterTreePaths(listed: readonly string[], query: string, displayName: (name: string) => string = (n) => n): string[] {
  const tokens = treeFilterTokens(query);
  if (tokens.length === 0) return [...listed];
  const memo = new Map<string, boolean>();
  const matches = (name: string, path: string): boolean => {
    let hit = memo.get(path);
    if (hit === undefined) {
      const haystack = normalizeFilterText(`${name} ${displayName(name)} ${path}`);
      hit = tokens.every((t) => haystack.includes(t));
      memo.set(path, hit);
    }
    return hit;
  };
  const out: string[] = [];
  for (const entry of listed) {
    const norm = normalizeTreePath(entry);
    if (!norm) continue;
    let prefix = '';
    for (let i = 0; i < norm.segments.length; i++) {
      prefix = i === 0 ? norm.segments[0] : `${prefix}/${norm.segments[i]}`;
      if (matches(norm.segments[i], prefix)) {
        out.push(entry);
        break;
      }
    }
  }
  return out;
}
