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
  window.addEventListener('click', (event) => {
    if (event.detail === 0) last = 'keyboard';
  }, true);
}

export function lastInput(): 'keyboard' | 'pointer' | null {
  return last;
}

export function inputMark(): number {
  return seq;
}

export function actedSince(mark: number): boolean {
  return seq !== mark;
}

let traversedAt = Number.NEGATIVE_INFINITY;
if (typeof window !== 'undefined') window.addEventListener('popstate', () => (traversedAt = performance.now()), true);

export function traversedJustNow(within = 1500): boolean {
  return performance.now() - traversedAt < within;
}
