/**
 * The tree's filter, with FileBrowser's rules (sidebar/FileBrowser.tsx,
 * `getFileTreeFilterTokens` + `filterFileTree`): the query splits on spaces,
 * backslashes read as `/`, case is ignored, and a listed path shows when every
 * token appears in it (with its folders). FileBrowser also matches "name
 * displayName path", but name and display name are parts of the path and a
 * token holds no space, so the path alone decides the same.
 */

export function treeFilterTokens(query: string): string[] {
  return query.replace(/\\/g, '/').toLowerCase().trim().split(/\s+/).filter(Boolean);
}

/** The test `FileTreeModel.setFilter` takes, or null for an empty query. */
export function treeFilterTest(query: string): ((lowercasePath: string) => boolean) | null {
  const tokens = treeFilterTokens(query);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) {
    const only = tokens[0];
    return (lc) => lc.includes(only);
  }
  return (lc) => tokens.every((t) => lc.includes(t));
}
