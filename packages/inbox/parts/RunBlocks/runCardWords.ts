/**
 * The run card's words and small hooks: how a run stands and what the agent was told, where a secret's field is,
 * and whether the command box has more below what it shows.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { RunView } from '../../data/runApi';

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

/** How a run stands, in words, and its tone. */
export function runStatus(run: RunView): { text: string; tone: 'live' | 'ok' | 'bad' | 'mut' } {
  if (run.state === 'starting') return { text: 'Starting…', tone: 'live' };
  if (run.state === 'running') return { text: `Running · ${Math.floor(run.duration_ms / 1000)} s`, tone: 'live' };
  // A lost run the person stopped here reads like any run they stopped (the hint says what came before).
  if (run.interrupted === 'lost') return run.left_running === false && run.signal ? { text: 'Stopped', tone: 'mut' } : { text: 'The Inbox stopped while this ran', tone: 'mut' };
  if (run.interrupted === 'closed') return { text: `Stopped: the Inbox closed after ${secs(run.duration_ms)}`, tone: 'mut' };
  if (run.state === 'stopped') return { text: `Stopped after ${secs(run.duration_ms)}`, tone: 'mut' };
  if (run.exit_code === null && run.error) return { text: "Couldn't start", tone: 'bad' };
  const how = run.exit_code !== null ? `exit code ${run.exit_code}` : `ended by ${run.signal ?? 'a signal'}`;
  return { text: `${run.state === 'done' ? 'Done' : 'Failed'} · ${how} · ${secs(run.duration_ms)}`, tone: run.state === 'done' ? 'ok' : 'bad' };
}

/** What the agent was told, in one line, for a run that ended (true for each way it can end). */
export function runHint(run: RunView, agent: string, computer: string): string {
  if (run.interrupted === 'lost') {
    if (run.left_running === true) return `It is still running on ${computer}: Stop ends it. ${agent} was told the Inbox stopped while it ran.`;
    if (run.left_running === false && run.signal) return `You stopped it. ${agent} was told the Inbox stopped while it ran.`;
    if (run.left_running === false) return `It ended while the Inbox was away. ${agent} was told the Inbox stopped while it ran.`;
    return `It may still be running on ${computer}. ${agent} was told the Inbox stopped while it ran.`;
  }
  if (run.interrupted === 'closed') return `${agent} was told the Inbox closed while it ran${run.total_lines > 0 ? ', with the last lines of output' : ''}.`;
  if (run.error && run.exit_code === null && run.total_lines === 0) return `${agent} was told why it couldn't start.`;
  if (run.state === 'stopped') return `${agent} was told you stopped it${run.total_lines > 0 ? ', with the last lines of output' : ''}.`;
  if (run.exit_code === null) return `${agent} got how it ended and the last lines of output.`;
  return `${agent} got the exit code and the last lines of output.`;
}

/** Brings a secret's one field into view and into focus (it sits on its secret card, or another run's card). */
export const goToField = (name: string) => {
  const input = document.querySelector<HTMLInputElement>(`[data-secret-form="${name}"] input`);
  if (!input) return;
  input.scrollIntoView({ block: 'center', behavior: 'smooth' });
  input.focus({ preventScroll: true });
};

/**
 * Where a secret's one field is from this card, for its "Save it …" button: above or below in the page, or "in its
 * card" when it is not on the page (a folded message).
 */
export function useFieldPlaces(card: HTMLElement | null, names: readonly string[]): Record<string, 'above' | 'below' | null> {
  const [places, setPlaces] = useState<Record<string, 'above' | 'below' | null>>({});
  const key = names.join(',');
  useLayoutEffect(() => {
    if (!card || names.length === 0) return;
    const next: Record<string, 'above' | 'below' | null> = {};
    for (const name of names) {
      const field = document.querySelector(`[data-secret-form="${name}"]`);
      next[name] = field ? (field.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING ? 'above' : 'below') : null;
    }
    setPlaces((was) => (names.every((name) => was[name] === next[name]) ? was : next));
  });
  return key === '' ? {} : places;
}

/**
 * Whether a scroll box has more below what it shows: the command box fades at its foot while it does (the project
 * list's hint in the sidebar), so a command cut mid-line on a phone says it scrolls.
 */
export function useMoreBelow<T extends HTMLElement>(deps: unknown) {
  const ref = useRef<T>(null);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    read();
    el.addEventListener('scroll', read, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', read);
      observer?.disconnect();
    };
  }, [deps]);
  return [ref, more] as const;
}
