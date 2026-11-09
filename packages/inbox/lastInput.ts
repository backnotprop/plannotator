/**
 * The person's last way of acting: a key, or a pointer (a mouse, a finger,
 * a pen). The window moves focus for the person (to a closed thread's row, to
 * the row now in a gone row's slot, to the first row Show brought in) only
 * after a key: after a mouse or a tap it would put a row under the keyboard
 * that the person never chose, and `E` would mark it read. The same goes for
 * a file's tile when a file closes (Thread.tsx).
 */
let last: 'keyboard' | 'pointer' | null = null;
/** How many keys and pointer presses the person has made: a timer that places focus later yields once this moves. */
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

/**
 * A mark of the person's input so far. A focus placed by a timer (a beat after Back, a search landing) checks
 * `actedSince(mark)` first: a key or a press since means the person has moved on (a Send, an Escape), and the
 * late placement would take focus from where that put it.
 */
export function inputMark(): number {
  return seq;
}

export function actedSince(mark: number): boolean {
  return seq !== mark;
}

/** When the browser's Back or Forward last landed (a popstate). */
let traversedAt = Number.NEGATIVE_INFINITY;
if (typeof window !== 'undefined') window.addEventListener('popstate', () => (traversedAt = performance.now()), true);

/**
 * A change the page is making now came from Back or Forward (a popstate within the last 1.5 s: a slow machine
 * draws the page that late), not a key or a click in the page.
 */
export function traversedJustNow(within = 1500): boolean {
  return performance.now() - traversedAt < within;
}
