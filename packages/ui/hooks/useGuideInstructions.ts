import { useCallback, useEffect, useRef, useState } from 'react';

function putInstructions(value: string) {
  void fetch('/api/agents/guide-instructions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instructions: value }),
  }).catch(() => {});
}

export function useGuideInstructions(enabled = true) {
  const [instructions, setInstructions] = useState('');
  const latest = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/agents/guide-instructions')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { instructions?: unknown } | null) => {
        if (!cancelled && data && typeof data.instructions === 'string') {
          setInstructions(data.instructions);
          latest.current = data.instructions;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        putInstructions(latest.current);
      }
    };
  }, [enabled]);

  const change = useCallback((value: string) => {
    setInstructions(value);
    latest.current = value;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      putInstructions(value);
    }, 400);
  }, []);

  return { instructions, setInstructions: change };
}
