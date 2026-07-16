/** Last path segment (the file name) for display, falling back to the full path. */
export function fileBasename(path: string): string {
  return path.split('/').pop() || path;
}
