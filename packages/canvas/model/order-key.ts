/**
 * Drawing order as a key on each object, not a position in a list.
 *
 * Every object carries `z`, a short string; objects are drawn in the order
 * of their keys (ties broken by id, so every reader agrees). Moving one
 * object in front of another is then a change to ONE field of ONE object,
 * carried by the ordinary `object-set` event. Two people who reorder
 * different objects at the same moment both keep what they did, which a
 * shared list of positions cannot give.
 *
 * A key is a base-62 number of fixed width, with a fraction after it only
 * when something had to be put between two neighbours with no room left.
 * New objects go on top with a wide step, so keys stay six characters for
 * any board that is mostly added to, and there is always a key between any
 * two.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const WIDTH = 6;
const MAX = BASE ** WIDTH - 1;
/** Room left between two objects added one after the other. */
const STEP = 4096;

export const ORDER_KEY_RE = /^[0-9A-Za-z]{1,96}$/;
export const isOrderKey = (value: unknown): value is string => typeof value === 'string' && ORDER_KEY_RE.test(value);

function toInt(key: string): number {
  let n = 0;
  for (let i = 0; i < WIDTH; i++) n = n * BASE + Math.max(0, DIGITS.indexOf(key[i] ?? '0'));
  return n;
}

function fromInt(n: number): string {
  let out = '';
  for (let i = 0; i < WIDTH; i++) {
    out = DIGITS[n % BASE] + out;
    n = Math.floor(n / BASE);
  }
  return out;
}

/** A string strictly between `a` and `b` as fractions (`b` null: no upper bound). */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? DIGITS[0]) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : BASE;
  if (db - da > 1) return DIGITS[Math.round(0.5 * (da + db))];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

/**
 * A key that sorts after `below` and before `above`. Null for either means
 * "no neighbour on that side": on top of everything, or under everything.
 */
export function keyBetween(below: string | null, above: string | null): string {
  if (below === null && above === null) return fromInt(Math.floor(MAX / 2));
  if (above === null) {
    const next = toInt(below!) + STEP;
    return next <= MAX ? fromInt(next) : midpoint(below!, null);
  }
  if (below === null) {
    const next = toInt(above) - STEP;
    return next > 0 ? fromInt(next) : midpoint('', above);
  }
  const lo = toInt(below);
  const hi = toInt(above);
  if (hi - lo > 1) return fromInt(Math.floor((lo + hi) / 2));
  return midpoint(below, above);
}

/** How two objects compare in drawing order: by key, then by id. An object with no key sorts first. */
export function compareOrder(a: { id: string; z?: string }, b: { id: string; z?: string }): number {
  const za = a.z ?? '';
  const zb = b.z ?? '';
  return za < zb ? -1 : za > zb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
