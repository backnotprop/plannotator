/**
 * The "Star the repo" ask on the done screen of plan review, code review and annotate (approval "star-ask"): the card
 * in place under the done message (`CompletionOverlay`'s `footer`), after the person sent their decision. Plannotator's
 * apps call `useStarAskDoneScreen`; a host that does not (the Workspaces app) never shows it.
 *
 * The session's server stops as soon as the decision is sent (the agent is waiting on it), so the done screen cannot
 * reach it. The page therefore claims while the session is open, once it has loaded, and holds the answer:
 *  - only when the page's own gates hold: a live session (never shared, archive, read-only, the share portal or the
 *    VS Code webview: `eligible`) and auto-close off (with it on, the tab closes on the decision);
 *  - the server decides the rest (packages/shared/star-ask.ts: a release build, a returning person, never shown on
 *    any surface, the already-starred check with the person's gh) and stamps it when it says `show`;
 *  - the card shows only on the done screen, after a decision (`decided`). Its button is always the plain link to the
 *    repository here: starring with gh needs the server, which has stopped by then (the Inbox stars with gh).
 * `POST /api/star-ask/claim` and `/answer` (both runtimes).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getAutoCloseDelay } from '../utils/storage';
import { StarAskCard } from './StarAskCard';

export interface StarAskClient {
  claim(): Promise<{ show: boolean; can_star: boolean }>;
  answer(answer: 'not-now' | 'opened'): Promise<unknown>;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** The plan, review and annotate servers' routes (both runtimes). */
export const starAskHttpClient: StarAskClient = {
  claim: () => post('/api/star-ask/claim'),
  // Best effort: the server has usually stopped by the time the person answers; the claim already recorded it.
  answer: (answer) => post('/api/star-ask/answer', { answer }).catch(() => undefined),
};

export interface StarAskDoneScreenInput {
  /** The session's page has loaded (the claim waits for it). */
  ready: boolean;
  /** The host's gates hold: a live session (not shared, archive, read-only or the portal), not the VS Code webview. */
  eligible: boolean;
  /** The person sent a decision and the done screen shows (approved, feedback, done; not a closed session). */
  decided: boolean;
  /** Tests: the routes. */
  client?: StarAskClient;
  /** Tests: the auto-close delay (default: the saved setting). */
  autoCloseDelay?: () => string;
}

/**
 * The card for the done screen, or null. Claims once per page, when `ready` and `eligible` first hold together with
 * auto-close off; the card shows on the done screen only if the server said so.
 */
export function useStarAskDoneScreen({ ready, eligible, decided, client = starAskHttpClient, autoCloseDelay = getAutoCloseDelay }: StarAskDoneScreenInput): ReactNode | null {
  const [claimed, setClaimed] = useState(false);
  const [gone, setGone] = useState(false);
  const asked = useRef(false);
  const api = useRef(client);
  api.current = client;

  useEffect(() => {
    if (!ready || !eligible || asked.current) return;
    asked.current = true;
    // Auto-close on: the tab closes on the decision, so it never asks.
    if (autoCloseDelay() !== 'off') return;
    api.current
      .claim()
      .then((answer) => {
        if (answer.show) setClaimed(true);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, eligible]);

  if (!claimed || gone || !decided || !eligible) return null;
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
