import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { inboxApi, type LiveSession, type LiveSessionsModel } from '../api';
import { whenTime } from '../format';
import { HostMark, Icon } from '../icons';
import { hostName, sessionWords } from './NewMessage';
import { ShortcutHint, useShortcutHintShown } from '../shortcuts/hint';
import { inboxAppShortcuts } from '../shortcuts/app.shortcuts';

export interface AskingSession {
  message: InboxMessageWire;
  session: string;
  host: string;
  name: string;
}

export const LEAVE = 'leave';

export interface RouteRow {
  live: LiveSession;
  ended: boolean;
  asker: boolean;
}

export interface RouteState {
  open: boolean;
  selected: string | null;
  rows: RouteRow[];
  error: string | null;
  focus: number;
  showAll: boolean;
}

export const CLOSED_ROUTE: RouteState = { open: false, selected: null, rows: [], error: null, focus: 0, showAll: false };

const FIRST_ROWS = 5;

/** An MCP-only agent or OpenCode 1 never polls, so it is never called ended. */
export const askerCanEnd = (asking: AskingSession | null): boolean => asking?.message.wakes === true;

export function askerHasEnded(asking: AskingSession | null, live: LiveSessionsModel | null): boolean {
  if (!asking || !askerCanEnd(asking) || !live?.asker || live.asker.session !== asking.session) return false;
  return !live.asker.live;
}

/** How long a read of one session's state may take: a Send waits on it, so a read that hangs must not hold it. */
export const SESSION_ENDED_READ_MS = 5_000;

async function sessionEnded(threadId: string, session: string): Promise<boolean> {
  try {
    const model = await inboxApi.sessions(threadId, session, [], SESSION_ENDED_READ_MS);
    return model.asker?.session === session && model.asker.live === false;
  } catch {
    return false;
  }
}

type KnownEnded = { threadId: string; ended: ReadonlyMap<string, boolean> };

function withRead(was: KnownEnded, threadId: string, read: readonly (readonly [string, boolean])[]): KnownEnded {
  const base = was.threadId === threadId ? was.ended : new Map<string, boolean>();
  if (was.threadId === threadId && read.every(([session, ended]) => base.get(session) === ended)) return was;
  const next = new Map(base);
  for (const [session, ended] of read) next.set(session, ended);
  return { threadId, ended: next };
}

export interface EndedSessions {
  ended: ReadonlySet<string>;
  unchecked: boolean;
  check: () => Promise<ReadonlySet<string>>;
}

/** A session not read yet is `unchecked`, never "not ended": a Send pressed before its read lands waits for `check`. */
export function useEndedSessions(threadId: string, sessions: readonly string[]): EndedSessions {
  const key = sessions.join('\u0000');
  const [known, setKnown] = useState<KnownEnded>({ threadId, ended: new Map() });
  const latest = useRef({ threadId, key, known });
  latest.current = { threadId, key, known };
  useEffect(() => {
    if (!key) return;
    let current = true;
    const load = async () => {
      const list = key.split('\u0000');
      const read = await Promise.all(list.map(async (session) => [session, await sessionEnded(threadId, session)] as const));
      if (current) setKnown((was) => withRead(was, threadId, read));
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [threadId, key]);
  const list = key ? key.split('\u0000') : [];
  const knownHere = known.threadId === threadId ? known.ended : null;
  const ended = new Set(list.filter((session) => knownHere?.get(session) === true));
  const unchecked = list.some((session) => !knownHere?.has(session));
  const check = async (): Promise<ReadonlySet<string>> => {
    const { threadId: id, key: now, known: was } = latest.current;
    const here = was.threadId === id ? was.ended : null;
    const all = now ? now.split('\u0000') : [];
    const read = await Promise.all(all.filter((session) => !here?.has(session)).map(async (session) => [session, await sessionEnded(id, session)] as const));
    if (read.length > 0) setKnown((prior) => withRead(prior, id, read));
    const fresh = new Map(read);
    return new Set(all.filter((session) => (fresh.get(session) ?? here?.get(session)) === true));
  };
  return { ended, unchecked, check };
}

export const othersLive = (asking: AskingSession, live: LiveSessionsModel | null): LiveSession[] =>
  (live?.sessions ?? []).filter((s) => s.session !== asking.session);

export function mergeRouteRows(current: RouteState, asking: AskingSession, live: LiveSessionsModel | null): RouteState {
  const sessions = live?.sessions ?? [];
  const byId = new Map(sessions.map((s) => [s.session, s]));
  const askerBack = byId.get(asking.session) ?? null;
  const rows: RouteRow[] = current.rows.map((row) => {
    const now = byId.get(row.live.session);
    return now ? { live: now, ended: false, asker: row.asker } : { ...row, ended: true };
  });
  for (const session of sessions) {
    if (rows.some((row) => row.live.session === session.session)) continue;
    rows.push({ live: session, ended: false, asker: session.session === asking.session });
  }
  let cameBack = false;
  if (askerBack) {
    const index = rows.findIndex((row) => row.live.session === asking.session);
    const [row] = rows.splice(index, 1);
    rows.unshift({ ...row!, asker: true });
    cameBack = !current.rows.some((r) => r.live.session === asking.session && !r.ended);
  }
  const pickable = (id: string | null) => id === LEAVE || rows.some((row) => row.live.session === id && !row.ended);
  let selected = current.selected;
  if (cameBack && current.open) selected = asking.session;
  if (!pickable(selected)) selected = rows.find((row) => !row.ended)?.live.session ?? LEAVE;
  return { ...current, rows, selected };
}

export function SessionEndedMark() {
  return (
    <>
      {' · '}
      <span className="ib-gone" data-session-ended="">
        session ended
      </span>
    </>
  );
}

export function AskerEndedNote({ asking, project, anyLive }: { asking: AskingSession; project: string; anyLive: boolean }) {
  return (
    <p className="ib-sessnote" data-asker-ended={anyLive ? 'live' : 'none-live'}>
      <Icon name="info" size={15} />
      {anyLive ? (
        <span>
          <b>This {asking.name} session has ended.</b> Send your reply to another session, or archive it if it's done.
        </span>
      ) : (
        <span>
          <b>This {asking.name} session has ended</b>, and no agent is running in {project} now. A reply waits here until that session is resumed.
        </span>
      )}
    </p>
  );
}

export function RouteChoice({
  kind = 'reply',
  reaskCount = 0,
  name,
  asking,
  project,
  state,
  sending,
  onSelect,
  onSubmit,
  onBack,
  onShowAll,
}: {
  kind?: 'reply' | 'reask';
  reaskCount?: number;
  name: string;
  asking: AskingSession;
  project: string;
  state: RouteState;
  sending: boolean;
  onSelect: (id: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  onShowAll: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state.open) return;
    formRef.current?.querySelector<HTMLInputElement>('input[type=radio]:checked')?.focus();
  }, [state.open, state.focus]);

  const selectedIndex = state.rows.findIndex((row) => row.live.session === state.selected);
  const visible = state.showAll ? state.rows : state.rows.slice(0, Math.max(FIRST_ROWS, selectedIndex + 1));
  const selectedRow = selectedIndex >= 0 ? state.rows[selectedIndex] : undefined;
  const hidden = state.rows.length - visible.length;
  const target = state.selected === LEAVE ? null : (selectedRow?.live ?? null);
  const reask = kind === 'reask';
  const primary = target ? (reask ? `Ask ${hostName(target.host)} to re-ask` : `Send to ${hostName(target.host)}`) : 'Leave it for the next agent';
  const whyId = `${name}-why`;
  const labelId = `${name}-gl`;

  const onRadioKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <form
      className="ib-routeform"
      ref={formRef}
      data-route-choice=""
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onBack();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset className="ib-route" aria-describedby={whyId}>
        <legend>{reask ? 'Who should ask again?' : 'Where should this reply go?'}</legend>
        <p className="ib-why" id={whyId}>
          {reask
            ? `The ${asking.name} session that asked has ended. The session you pick reads this thread, then asks ${reaskCount === 1 ? 'the open question again' : `the ${reaskCount} open questions again in one message`}.`
            : `The ${asking.name} session that asked has ended. Your reply stays as you wrote it.`}
        </p>
        {state.rows.length > 0 && (
          <div className="ib-gl" id={labelId}>
            Send to a live session in {project}
          </div>
        )}
        {visible.map((row) => (
          <label className="ib-opt" key={row.live.session} data-route-session={row.live.session} data-ended={row.ended ? '' : undefined}>
            <input
              type="radio"
              name={name}
              value={row.live.session}
              checked={state.selected === row.live.session}
              disabled={row.ended}
              aria-describedby={labelId}
              onChange={() => onSelect(row.live.session)}
              onKeyDown={onRadioKey}
            />
            <HostMark host={row.live.host} agent={row.live.session} />
            <span>
              <span className="ib-t">
                {hostName(row.live.host)} · {row.asker ? 'the session that asked' : `started ${whenTime(row.live.started_at)}`}
              </span>
              <span className="ib-d">{row.ended ? 'Ended just now.' : sessionWords(row.live)}</span>
            </span>
          </label>
        ))}
        {hidden > 0 && (
          <button type="button" className="ib-more" onClick={onShowAll}>
            Show {hidden} more
          </button>
        )}
        {state.rows.length > 0 && <hr />}
        <label className="ib-opt" data-route-session={LEAVE}>
          <input type="radio" name={name} value={LEAVE} checked={state.selected === LEAVE} onChange={() => onSelect(LEAVE)} onKeyDown={onRadioKey} />
          <span className="ib-mk">
            <Icon name="clock" size={16} />
          </span>
          <span>
            <span className="ib-t">Leave it for the next agent</span>
            <span className="ib-d">It waits in this thread until an agent reads it.</span>
          </span>
        </label>
      </fieldset>
      {state.error && (
        <div className="ib-error ib-route-error" role="alert">
          {state.error}
        </div>
      )}
      <div className="ib-acts ib-route-acts">
        <button type="submit" className="ib-btn ib-pri" disabled={sending} data-route-send="">
          <Icon name="send" size={15} />
          {primary}
        </button>
        <button type="button" className="ib-btn ib-ghost" onClick={onBack}>
          {reask ? 'Cancel' : 'Back to the reply'}
        </button>
        <span className="ib-sp" />
        <EscNote />
      </div>
    </form>
  );
}

export function routeRace(state: RouteState, ended: string, sent: { went: number; total: number } = { went: 0, total: 1 }): RouteState {
  const rows = state.rows.map((row) => (row.live.session === ended ? { ...row, ended: true } : row));
  const gone = state.rows.find((row) => row.live.session === ended);
  const next = rows.find((row) => !row.ended) ?? null;
  const error = `${raceWhat(gone?.live.host ?? null, sent)} ${next ? `${hostName(next.live.host)} is selected now.` : 'Leave it for the next agent, or start a session.'}`;
  return { ...state, rows, selected: next?.live.session ?? LEAVE, error, focus: state.focus + 1 };
}

export function raceWhat(host: string | null, sent: { went: number; total: number }): string {
  const name = host ? `${hostName(host)} ` : '';
  return sent.went > 0
    ? `That ${name}session ended before all of your reply went. ${sent.went} of ${sent.total} agents got their reply; the rest did not.`
    : `That ${name}session ended before your reply went. Nothing was sent.`;
}

export function redirectedName(to: { host: string; session: string }, asked: InboxMessageWire | undefined): string {
  const name = hostName(to.host);
  if (!asked || asked.author.kind !== 'agent') return name;
  const sameHost = asked.author.host !== null && hostName(asked.author.host) === name;
  return sameHost && asked.author.session !== to.session ? `${name} (another session)` : name;
}

export const isRedirected = (message: InboxMessageWire): boolean => message.author.kind === 'person' && !!message.to && !!message.reply_to;


function EscNote() {
  if (!useShortcutHintShown({ scope: inboxAppShortcuts, action: 'leavePage' })) return null;
  return (
    <span className="ib-esc">
      <ShortcutHint scope={inboxAppShortcuts} action="leavePage" className="" /> goes back
    </span>
  );
}
