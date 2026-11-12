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
