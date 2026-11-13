import { notifyManager } from '@tanstack/react-query';

export const DRAW_GAP_MS = 100;
export const DRAW_SETTLE_MS = 16;

const waiting: (() => void)[] = [];
let lastAt = Number.NEGATIVE_INFINITY;
let firstAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  lastAt = Date.now();
  const writes = waiting.splice(0);
  notifyManager.batch(() => {
    for (const write of writes) write();
  });
}

export function drawNow(): void {
  if (timer === null) return;
  clearTimeout(timer);
  flush();
}

export function drawSoon(write: () => void): void {
  const now = Date.now();
  if (lastAt > now) lastAt = now - DRAW_GAP_MS;
  if (waiting.length === 0) firstAt = now;
  waiting.push(write);
  if (timer !== null) clearTimeout(timer);
  const at = Math.max(lastAt + DRAW_GAP_MS, Math.min(now + DRAW_SETTLE_MS, firstAt + DRAW_GAP_MS));
  timer = setTimeout(flush, Math.max(0, at - now));
}
