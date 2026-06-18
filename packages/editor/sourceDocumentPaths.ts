export function normalizeBrowserPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized === '/') return normalized;
  return normalized.replace(/\/+$/, '');
}

export function dirnameBrowserPath(path: string): string {
  const normalized = normalizeBrowserPath(path);
  const index = normalized.lastIndexOf('/');
  if (index < 0) return normalized;
  if (index === 0) return '/';
  return normalized.slice(0, index);
}

export function pathIsInsideDir(path: string, dir: string): boolean {
  const normalizedPath = normalizeBrowserPath(path);
  const normalizedDir = normalizeBrowserPath(dir);
  return normalizedPath === normalizedDir || normalizedPath.startsWith(`${normalizedDir}/`);
}
