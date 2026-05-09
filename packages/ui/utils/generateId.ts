export function generateId(prefix?: string): string {
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

  return prefix ? `${prefix}-${id}` : id;
}
