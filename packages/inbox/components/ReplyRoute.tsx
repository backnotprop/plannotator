import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import type { LiveSession, LiveSessionsModel } from '../api';
import { whenTime } from '../format';
import { HostMark, Icon } from '../icons';
import { hostName, sessionWords } from './NewMessage';
import { ShortcutHint, useShortcutHintShown } from '../shortcuts/hint';
import { inboxAppShortcuts } from '../shortcuts/app.shortcuts';

/**
 * Replying when the session that asked has ended (design record "replying
 * when the asking agent's session has ended", not in this repo; owner
 * approval 2026-10-11, "build it as mocked").
 *
 * Every agent message records the session that sent it, and the person's
 * reply wakes only that session. When that session is no longer there, the
 * thread says so before the person replies (a quiet note in the foot and
 * "session ended" on the asking message), and at Send the person chooses
 * where the reply goes: a live session of the project, or "Leave it for the
 * next agent" (what a reply always did). The choice is always manual. With no
 * live session there is only one outcome, so Send sends at once.
 */

/** The session that asked: the agent message the reply's words answer. */
export interface AskingSession {
  message: InboxMessageWire;
  session: string;
  host: string;
  /** "Claude Code": the agent as the thread names it. */
  name: string;
}

/** The value of the "Leave it for the next agent" option. */
export const LEAVE = 'leave';

/** One row of the choice: a live session, the asking session back again, or one that ended while the choice was open. */
export interface RouteRow {
  live: LiveSession;
  ended: boolean;
  asker: boolean;
}

export interface RouteState {
  open: boolean;
  /** The selected row's session id, or LEAVE. Kept with the draft when the choice closes. */
  selected: string | null;
  rows: RouteRow[];
  error: string | null;
  /** Bumped to move focus to the selected radio. */
  focus: number;
  showAll: boolean;
}

export const CLOSED_ROUTE: RouteState = { open: false, selected: null, rows: [], error: null, focus: 0, showAll: false };

/** How many rows show before "Show N more". */
const FIRST_ROWS = 5;

/**
 * Whether the asking message is evidence that its session can end: it came
 * through a connection that wakes its session (`wakes`, the Claude Code mod,
 * Pi, OpenCode 2). An MCP-only agent or OpenCode 1 never polls, and may be
 * waiting in wait_for_reply right now, so it is never called ended.
 */
export const askerCanEnd = (asking: AskingSession | null): boolean => asking?.message.wakes === true;

/**
 * Whether the session that asked has ended, as the window can know it: its
 * message came through a waking connection, and the Inbox has not heard from
 * it since (no poll, no MCP call, no open wait; with the server's 60 s grace).
 */
export function askerHasEnded(asking: AskingSession | null, live: LiveSessionsModel | null): boolean {
  if (!asking || !askerCanEnd(asking) || !live?.asker || live.asker.session !== asking.session) return false;
  return !live.asker.live;
}

/** The project's live sessions other than the one that asked. */
export const othersLive = (asking: AskingSession, live: LiveSessionsModel | null): LiveSession[] =>
  (live?.sessions ?? []).filter((s) => s.session !== asking.session);

/**
 * The rows as the live list reads now, merged with the rows on screen: a row
 * whose session left stays, greyed ("Ended just now."); a new live session is
 * added; the asking session, back again, goes to the top. Then the selection:
 * the asking session when it came back, else the one kept, else the first
 * live row, else Leave.
 */
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

/** The asking message's sender row: "to you · session ended". */
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

/** The note at the top of the foot, before the person replies (two variants); the host's always-mounted status region holds it. */
export function AskerEndedNote({ asking, project, anyLive }: { asking: AskingSession; project: string; anyLive: boolean }) {
  return (
    <p className="ib-sessnote" data-asker-ended={anyLive ? 'live' : 'none-live'}>
      <Icon name="info" size={15} />
      {anyLive ? (
        <span>
          <b>The {asking.name} session that asked has ended.</b> When you send, you can pick a live session in {project} to take your reply.
        </span>
      ) : (
        <span>
          <b>The {asking.name} session that asked has ended</b>, and no agent is running in {project} now. Your reply will wait here until an agent reads this thread.
        </span>
      )}
    </p>
  );
}

/**
 * The choice at Send, in place of the actions row: one radio group of the
 * project's live sessions (New message's rows) and "Leave it for the next
 * agent". The primary button names the result.
 */
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
  /** What the choice is for: a reply, or a Re-ask (approval "inbox-reask"), which asks who should ask again. */
  kind?: 'reply' | 'reask';
  /** The open questions a Re-ask asks for again. */
  reaskCount?: number;
  /** The radio group's name, unique per thread. */
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
  // Send (or Cmd/Ctrl+Enter) puts focus on the selected radio; so does the race.
  useEffect(() => {
    if (!state.open) return;
    formRef.current?.querySelector<HTMLInputElement>('input[type=radio]:checked')?.focus();
  }, [state.open, state.focus]);

  // The first five rows, or up to the selected one when it is further down,
  // so it stays in view and in its place when "Show N more" opens the rest.
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
      // Esc goes back to the reply, from any control in the choice. The
      // Escape is marked used, so the window's own Esc (close the thread)
      // leaves it alone.
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
            <HostMark host={row.live.host} />
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

/**
 * The race: the chosen session ended before the reply went. The row greys,
 * the next live row is selected, and the error says so. A Send that answers
 * several agent sessions posts one reply to each; when some went before the
 * refusal, the error says how many, never "Nothing was sent".
 */
export function routeRace(state: RouteState, ended: string, sent: { went: number; total: number } = { went: 0, total: 1 }): RouteState {
  const rows = state.rows.map((row) => (row.live.session === ended ? { ...row, ended: true } : row));
  const gone = state.rows.find((row) => row.live.session === ended);
  const next = rows.find((row) => !row.ended) ?? null;
  const name = gone ? hostName(gone.live.host) : 'That';
  const what =
    sent.went > 0
      ? `That ${name} session ended before all of your reply went. ${sent.went} of ${sent.total} agents got their reply; the rest did not.`
      : `That ${name} session ended before your reply went. Nothing was sent.`;
  const error = `${what} ${next ? `${hostName(next.live.host)} is selected now.` : 'Leave it for the next agent, or start a session.'}`;
  return { ...state, rows, selected: next?.live.session ?? LEAVE, error, focus: state.focus + 1 };
}

/**
 * "Claude Code (another session)": the host of the session that took a reply
 * the person sent elsewhere, marked when it is the asker's own host, because
 * only then can the person confuse the two.
 */
export function redirectedName(to: { host: string; session: string }, asked: InboxMessageWire | undefined): string {
  const name = hostName(to.host);
  if (!asked || asked.author.kind !== 'agent') return name;
  const sameHost = asked.author.host !== null && hostName(asked.author.host) === name;
  return sameHost && asked.author.session !== to.session ? `${name} (another session)` : name;
}

/** Whether the person's reply went to another session than the one that asked. */
export const isRedirected = (message: InboxMessageWire): boolean => message.author.kind === 'person' && !!message.to && !!message.reply_to;


/** "Esc goes back": the keycap from the registry, the note gone with it when hints are off. */
function EscNote() {
  if (!useShortcutHintShown({ scope: inboxAppShortcuts, action: 'leavePage' })) return null;
  return (
    <span className="ib-esc">
      <ShortcutHint scope={inboxAppShortcuts} action="leavePage" className="" /> goes back
    </span>
  );
}
