/**
 * Records written into the cache at most once per DRAW_GAP_MS: a record after a quiet spell is written at once, and
 * those that come close behind it wait and go in together, as one redraw. An agent writing many lines a second
 * would otherwise redraw the open thread on every line and hold the tab's main thread for seconds.
 */
import { notifyManager } from '@tanstack/react-query';

export const DRAW_GAP_MS = 100;

const waiting: (() => void)[] = [];
let lastAt = Number.NEGATIVE_INFINITY;
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  lastAt = Date.now();
  const writes = waiting.splice(0);
  notifyManager.batch(() => {
    for (const write of writes) write();
  });
}

export function drawSoon(write: () => void): void {
  const now = Date.now();
  if (timer === null && now - lastAt >= DRAW_GAP_MS) {
    lastAt = now;
    write();
    return;
  }
  waiting.push(write);
  timer ??= setTimeout(flush, Math.max(0, lastAt + DRAW_GAP_MS - now));
}
