/**
 * A v4 UUID that also works in an insecure context. `crypto.randomUUID` exists only in a secure
 * context (https or localhost), so the Inbox opened over plain http on another address would throw.
 * `crypto.getRandomValues` has no such limit.
 */
export function newUuid(): string {
  if (typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // Fall through to getRandomValues.
    }
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
