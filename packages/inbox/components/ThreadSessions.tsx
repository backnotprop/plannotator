import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { useAgentFacesKey } from '../agents/agentFaces';
import type { ThreadSession } from '../agents/model';
import { inboxAgentsFlat, useInboxAgents } from '../agentsList';
import { HostMark } from '../icons';
import { agentName } from '../tags';
import { Tip } from './Tip';

/**
 * Who is in a thread with two or more sessions (issue #3108, approval "inbox-thread-session-names", "Unfold"): the
 * header's line shows a small pile of the sessions' marks and "N sessions"; a hover (a mouse), a tap or keyboard focus
 * opens it in place into each session's name and what it is doing. One session: not drawn (the header as before).
 *
 * The marks are the faces the sessions already have (agents/agentFaces.ts): a face picked in the sidebar, else the
 * agent's own mark. Sessions that look the same share one mark: three Claude Code sessions with no face of their own
 * are one Claude mark and "3 sessions", never three identical marks; opened, a mark starts each run of sessions that
 * look alike. Nothing here picks or saves a face.
 *
 * The names come from `threadSessions` (agents/model.ts), the sidebar's names. The states come from the list's agents,
 * read here so only this line draws again when one changes (reading them is what keeps the list's agents fresh, as
 * the sidebar's Agents section does).
 */

/** What each session is doing, in the opened line. */
export const SESSION_STATE_WORDS: Record<NonNullable<ThreadSession['state']>, string> = {
  waiting: 'waiting on you',
  working: 'working',
  idle: 'idle',
  ended: 'ended',
};

/** The most marks the closed pile draws. */
export const PILE_MARKS = 4;

/** Each session's look: its face when it has one, else its agent's own mark (one per agent, by name). */
export function sessionLooks(sessions: readonly Pick<ThreadSession, 'host'>[], faces: readonly string[]): string[] {
  return sessions.map((s, i) => {
    const face = faces[i] ?? 'agent';
    return face === 'agent' ? `agent:${agentName(s.host)}` : `face:${face}`;
  });
}

/** The sessions the closed pile draws: the first of each look, at most PILE_MARKS. */
export function pileSessions(looks: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < looks.length && out.length < PILE_MARKS; i++) if (looks.indexOf(looks[i]!) === i) out.push(i);
  return out;
}

export interface ThreadSessionsProps {
  sessions: readonly ThreadSession[];
  /** A phone: opened, one session per line. */
  phone?: boolean;
}

export function ThreadSessions({ sessions, phone = false }: ThreadSessionsProps) {
  const groups = useInboxAgents();
  // The same id on two machines is two agents: each is found under its own machine.
  const live = new Map(inboxAgentsFlat(groups).map((a) => [`${a.machine ?? ''}\n${a.id}`, a.state] as const));
  const faces = useAgentFacesKey(sessions.map((s) => s.session)).split('\n');
  const looks = sessionLooks(sessions, faces);
  // How it was opened: a mouse resting on it closes when it leaves; a click, a tap or focus keeps it until it is
  // closed (Escape, a click or tap outside, focus leaving it, a second click on its marks).
  const [open, setOpen] = useState<null | 'hover' | 'held'>(null);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  /** The next focus on the button comes from a press or from Escape: it does not open the line. */
  const pressed = useRef(false);

  useEffect(() => {
    if (open !== 'held') return;
    // A tap outside (a touch screen does not move focus to a button) or a click outside closes it.
    const away = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);

  if (sessions.length < 2) return null;
  const count = `${sessions.length} sessions`;
  const pile = pileSessions(looks);
  const mark = (i: number) => <HostMark key={sessions[i]!.session} host={sessions[i]!.host} agent={sessions[i]!.session} />;

  const enter = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && !open) setOpen('hover');
  };
  const leave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && open === 'hover') setOpen(null);
  };
  const focus = () => {
    // Keyboard focus opens it; a press (a mouse, a tap) is the click's to decide, and Escape's own return opens nothing.
    const quietly = pressed.current;
    pressed.current = false;
    if (!open && !quietly) setOpen('held');
  };
  const blur = (e: FocusEvent) => {
    if (open === 'held' && !(e.relatedTarget instanceof Node && box.current?.contains(e.relatedTarget))) setOpen(null);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return;
    // This Escape closes the line, never the thread under it (App's ladder skips a used key).
    e.preventDefault();
    e.stopPropagation();
    setOpen(null);
    pressed.current = true;
    toggle.current?.focus();
    pressed.current = false;
  };

  // A click on the marks or on the opened line: a line a mouse opened stays; an open one closes; a closed one opens.
  const press = () => {
    pressed.current = false;
    setOpen(open === 'hover' ? 'held' : open ? null : 'held');
  };

  return (
    <div
      ref={box}
      className="ib-ss"
      data-thread-participants=""
      data-thread-sessions={sessions.length}
      data-open={open ? '' : undefined}
      data-phone={phone ? '' : undefined}
      onPointerEnter={enter}
      onPointerLeave={leave}
      onBlur={blur}
      onKeyDown={key}
    >
      <button
        ref={toggle}
        type="button"
        className="ib-ss-tog"
        aria-expanded={!!open}
        aria-label={count}
        onPointerDown={() => (pressed.current = true)}
        onFocus={focus}
        onClick={press}
      >
        <span className="ib-ss-pile" aria-hidden="true" data-pile={pile.length}>
          {pile.map(mark)}
        </span>
        <span className="ib-ss-n" aria-hidden="true">
          {count}
        </span>
      </button>
      {/* Opened: over the line on a computer (nothing under it moves), below the marks on a phone. */}
      {open && (
        <div className="ib-ss-band" onClick={press}>
          <ul className="ib-ss-list" aria-label={count}>
            {sessions.map((s, i) => {
              const state = (s.agentId ? live.get(`${s.machine ?? ''}\n${s.agentId}`) : undefined) ?? s.state;
              return (
                <li key={s.session} className="ib-ss-item" data-session={s.session} data-state={state ?? undefined}>
                  {/* A mark starts each run of sessions that look alike. */}
                  {i === 0 || looks[i] !== looks[i - 1] ? (
                    <span className="ib-ss-mk" aria-hidden="true">
                      {mark(i)}
                    </span>
                  ) : (
                    <span className="ib-ss-mk ib-ss-none" aria-hidden="true" />
                  )}
                  <span className="ib-ss-txt">
                    <Tip content={s.name} cut>
                      <bdi className="ib-ss-nm">{s.name}</bdi>
                    </Tip>
                    {state && <span className="ib-ss-st">{SESSION_STATE_WORDS[state]}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
