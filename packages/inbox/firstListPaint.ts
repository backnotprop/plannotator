let painted = false;
let waiters: (() => void)[] = [];

export function listPainted(): void {
  if (painted) return;
  painted = true;
  const go = waiters;
  waiters = [];
  setTimeout(() => {
    for (const wake of go) wake();
  }, 0);
}

export function afterListPaint(capMs = 300): Promise<void> {
  if (painted) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(done, capMs);
    waiters.push(() => {
      clearTimeout(timer);
      done();
    });
  });
}
