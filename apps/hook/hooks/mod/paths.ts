/**
 * Paths as every host the mod runs on writes them. Claude Code hands a Windows
 * session its folders as `C:\…`, so a check for a leading `/` alone reads
 * every Windows path as relative. The mod joins its own paths with `/`, which
 * Windows accepts.
 */

/** `/x` (POSIX), `C:\x` or `C:/x` (a Windows drive), or `\\server\share` (UNC). */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** `path` without trailing separators, keeping a root whole: `/` stays `/`, `C:\` stays `C:\`, never the drive-relative `C:`. */
export function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed === '') return path.startsWith('/') ? '/' : trimmed
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}${path.charAt(2)}` : trimmed
}
