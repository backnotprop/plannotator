/** Focus is moved for the person only after a key: after a mouse or a tap it would put a row under the keyboard that they never chose, and `E` would mark it read. */
let last: 'keyboard' | 'pointer' | null = null;
let seq = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => {
    last = 'keyboard';
    seq += 1;
  }, true);
  window.addEventListener('pointerdown', () => {
    last = 'pointer';
    seq += 1;
  }, true);
  // A screen reader (or switch access) presses a control with a click that no key or pointer came
  // before, and that counts no clicks (`detail` 0): the person is not using a mouse.
  window.addEventListener('click', (event) => {
    if (event.detail === 0) last = 'keyboard';
  }, true);
}

export function lastInput(): 'keyboard' | 'pointer' | null {
  return last;
}

/** A focus placed by a timer checks `actedSince(mark)` first: a key or press since means the person has moved on. */
export function inputMark(): number {
  return seq;
}

export function actedSince(mark: number): boolean {
  return seq !== mark;
}

let traversedAt = Number.NEGATIVE_INFINITY;
if (typeof window !== 'undefined') window.addEventListener('popstate', () => (traversedAt = performance.now()), true);

/** Back or Forward (a popstate within 1.5 s: a slow machine draws the page that late), not a key or a click. */
export function traversedJustNow(within = 1500): boolean {
  return performance.now() - traversedAt < within;
}
