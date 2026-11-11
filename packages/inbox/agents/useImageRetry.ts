import { useEffect, useState } from 'react';

const RETRY_MS = [2_000, 8_000, 30_000];

export function useImageRetry(): [failed: boolean, fail: () => void] {
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!failed || tries >= RETRY_MS.length) return;
    const again = () => {
      setTries((n) => n + 1);
      setFailed(false);
    };
    const timer = setTimeout(again, RETRY_MS[tries]);
    window.addEventListener('online', again);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('online', again);
    };
  }, [failed, tries]);
  return [failed, () => setFailed(true)];
}
