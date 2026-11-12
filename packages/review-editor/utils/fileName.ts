export function fileBasename(path: string): string {
  return path.split('/').pop() || path;
}
