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

/**
 * A key never ends in the lowest digit. Between `A` and `A0` there is no string at all, so a key ending in
 * `0` could leave no room under it; with none allowed there is always a key between any two.
 */
export const ORDER_KEY_RE = /^[0-9A-Za-z]{0,95}[1-9A-Za-z]$/;
export const isOrderKey = (value: unknown): value is string => typeof value === 'string' && ORDER_KEY_RE.test(value);

function toInt(key: string): number {
  let n = 0;
  for (let i = 0; i < WIDTH; i++) n = n * BASE + Math.max(0, DIGITS.indexOf(key[i] ?? '0'));
  return n;
}

function fromInt(n: number): string {
  // Never a key ending in the lowest digit (see `ORDER_KEY_RE`): the next number up is as good.
  if (n % BASE === 0) n += 1;
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
  // Two neighbours with the same key (two people who each put something on top at the same moment) have
  // nothing between them: the new key goes JUST above both, by one more digit, so it passes nothing else
  // on the board (halfway to the top would jump over whatever lies above them). Every key that sorts above
  // the pair and does not start with their key still sorts above the new one.
  if (below !== null && above !== null && below >= above) {
    const key = below + DIGITS[BASE >> 1];
    return ORDER_KEY_RE.test(key) ? key : midpoint(below, null);
  }
  let key: string;
  if (above === null) {
    const next = toInt(below!) + STEP;
    key = next < MAX ? fromInt(next) : midpoint(below!, null);
  } else if (below === null) {
    const next = toInt(above) - STEP;
    key = next > 0 ? fromInt(next) : midpoint('', above);
  } else {
    const lo = toInt(below);
    const hi = toInt(above);
    key = hi - lo > 2 ? fromInt(Math.floor((lo + hi) / 2)) : midpoint(below, above);
  }
  // The quick paths work on the first six digits; a key that did not land strictly between is worked out in full.
  if ((below !== null && key <= below) || (above !== null && key >= above)) key = midpoint(below ?? '', above);
  return key;
}

/** How two objects compare in drawing order: by key, then by id. An object with no key sorts first. */
export function compareOrder(a: { id: string; z?: string }, b: { id: string; z?: string }): number {
  const za = a.z ?? '';
  const zb = b.z ?? '';
  return za < zb ? -1 : za > zb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
