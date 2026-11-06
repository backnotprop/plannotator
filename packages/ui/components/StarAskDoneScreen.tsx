/**
 * The "Star the repo" ask on the done screen of plan review, code review and annotate (approval "star-ask"): the card
 * in place under the done message (`CompletionOverlay`'s `footer`), after the person sent their decision. Plannotator's
 * apps call `useStarAskDoneScreen`; a host that does not (the Workspaces app) never shows it.
 *
 * Two steps, so the ask is used up only when the card draws:
 *  - at load, while the session is open, `POST /api/star-ask/claim`: every server gate (a release build, a returning
 *    person, never shown on any surface) and the already-starred check with the person's gh, kept for later loads.
 *    Nothing is used up: a reload, a session closed without a decision or a page that never reaches its done screen
 *    leaves the ask for later;
 *  - when the decision is sent and the done screen shows (`decided`), `POST /api/star-ask/shown` stamps it and the card
 *    draws only on `{ show: true }`. Every runtime keeps its server up 1500 ms after the decision (the hook's plan,
 *    review and annotate servers, OpenCode's, Pi's), and this local call takes milliseconds; if it fails, nothing shows
 *    and nothing is used up.
 * Only where the page's own gates hold (`eligible`): a live session, never shared, archive, read-only, the share portal,
 * goal setup or the VS Code webview; and auto-close off, read at load and again at the decision (with it on, the tab
 * closes on the decision). The card's button is always the plain link here: starring with gh needs the server, which
 * stops right after (the Inbox stars with gh).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getAutoCloseDelay } from '../utils/storage';
import { StarAskCard } from './StarAskCard';

export interface StarAskClient {
  /** At load: may the ask show later? Nothing is used up. */
  claim(): Promise<{ show: boolean; can_star: boolean }>;
  /** At the decision: the card draws now (stamped); `show: false` draws nothing. */
  shown(): Promise<{ show: boolean }>;
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
  shown: () => post('/api/star-ask/shown'),
  // Best effort: the server has usually stopped by the time the person answers; the stamp already recorded the show.
  answer: (answer) => post('/api/star-ask/answer', { answer }).catch(() => undefined),
};

export interface StarAskDoneScreenInput {
  /** The session's page has loaded (the claim waits for it). */
  ready: boolean;
  /** The host's gates hold: a live session (not shared, archive, read-only, the portal or goal setup), not the VS Code webview. */
  eligible: boolean;
  /** The person sent a decision and the done screen shows (approved, feedback, done; not a closed session). */
  decided: boolean;
  /** Tests: the routes. */
  client?: StarAskClient;
  /** Tests: the auto-close delay (default: the saved setting). */
  autoCloseDelay?: () => string;
}

/**
 * The card for the done screen, or null. Claims (checks) once per page, when `ready` and `eligible` first hold with
 * auto-close off; at the decision, if the claim said it may show, stamps it and draws the card.
 */
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
    // Auto-close on: the tab closes on the decision, so it never asks.
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
    // Auto-close turned on during the review: the tab closes now, so nothing is used up.
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
