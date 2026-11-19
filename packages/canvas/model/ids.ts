/** Ids for objects and snapshots: short, URL-safe, never reused. */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** What an id may look like. An agent can choose its own ids; they are held to this. */
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const isValidId = (value: unknown): value is string => typeof value === 'string' && ID_RE.test(value);

/** A fresh id such as `box-4f9k2m7qa1`. Random, so two peers never collide. */
export function createId(prefix: string): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}-${out}`;
}
