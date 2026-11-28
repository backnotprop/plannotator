import { useEffect, useState } from 'react';

let painted = false;
const waiting = new Set<() => void>();

export function markFirstCodePainted(): void {
  if (painted) return;
  painted = true;
  for (const resume of waiting) resume();
  waiting.clear();
}

export function hasFirstCodePainted(): boolean {
  return painted;
}

export function useAfterFirstCode(fallbackMs = 400): boolean {
  const [ready, setReady] = useState(painted);
  useEffect(() => {
    if (ready) return;
    const resume = () => setReady(true);
    waiting.add(resume);
    const timer = setTimeout(resume, fallbackMs);
    return () => {
      waiting.delete(resume);
      clearTimeout(timer);
    };
  }, [ready, fallbackMs]);
  return ready;
}
