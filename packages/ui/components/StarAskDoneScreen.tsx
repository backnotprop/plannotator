import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getAutoCloseDelay } from '../utils/storage';
import { StarAskCard } from './StarAskCard';

export interface StarAskClient {
  claim(): Promise<{ show: boolean; can_star: boolean }>;
  shown(): Promise<{ show: boolean }>;
  answer(answer: 'not-now' | 'opened'): Promise<unknown>;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

export const starAskHttpClient: StarAskClient = {
  claim: () => post('/api/star-ask/claim'),
  shown: () => post('/api/star-ask/shown'),
  answer: (answer) => post('/api/star-ask/answer', { answer }).catch(() => undefined),
};

export interface StarAskDoneScreenInput {
  ready: boolean;
  eligible: boolean;
  decided: boolean;
  client?: StarAskClient;
  autoCloseDelay?: () => string;
}

export function useStarAskDoneScreen({ ready, eligible, decided, client = starAskHttpClient, autoCloseDelay = getAutoCloseDelay }: StarAskDoneScreenInput): ReactNode | null {
  const [mayShow, setMayShow] = useState(false);
  const [shown, setShown] = useState(false);
  const [gone, setGone] = useState(false);
  const asked = useRef(false);
  const stamped = useRef(false);
  const api = useRef(client);
  api.current = client;
  const closeDelay = useRef(autoCloseDelay);
  closeDelay.current = autoCloseDelay;

  useEffect(() => {
    if (!ready || !eligible || asked.current) return;
    asked.current = true;
    if (closeDelay.current() !== 'off') return;
    api.current
      .claim()
      .then((answer) => {
        if (answer.show) setMayShow(true);
      })
      .catch(() => undefined);
  }, [ready, eligible]);

  useEffect(() => {
    if (!decided || !eligible || !mayShow || stamped.current) return;
    stamped.current = true;
    if (closeDelay.current() !== 'off') return;
    api.current
      .shown()
      .then((answer) => {
        if (answer.show) setShown(true);
      })
      .catch(() => undefined);
  }, [decided, eligible, mayShow]);

  if (!shown || gone || !decided || !eligible) return null;
  return (
    <StarAskCard
      shape="card"
      canStar={false}
      onStar={async () => false}
      onAnswer={(answer) => void api.current.answer(answer)}
      onLeave={() => setGone(true)}
    />
  );
}
