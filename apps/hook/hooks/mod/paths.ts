export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

export function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed === '') return path.startsWith('/') ? '/' : trimmed
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}${path.charAt(2)}` : trimmed
}
