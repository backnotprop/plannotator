/**
 * Where the card and the profile live in the window (approval "inbox-agent-profile-card"). App wraps the list and the
 * reading pane in `AgentProfileHost`: it tells the list's card and the Agents view's rows which agent the list is
 * filtered to and whose profile is open (`&profile=`), and draws the profile in the reading pane while one is open.
 *
 * Nothing runs for a person who does not use it: the host holds no state and reads nothing; the card draws only on a
 * list filtered to one agent, and the profile only while open.
 */
import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { Route } from '../app/route';
import type { MachinesModel } from '../machines';
import { AgentProfile } from './AgentProfile';

export interface AgentProfileNav {
  /** The agent the list is filtered to (`#agent=`): its card sits atop the list. */
  filter: string | null;
  /** The agent whose profile is open (`&profile=`); null: none. */
  open: string | null;
  machines: MachinesModel;
  /** Opens its profile in the reading pane, or closes it when it is the one open (a second press on the card). */
  toggle: (id: string) => void;
}

const NavContext = createContext<AgentProfileNav | null>(null);

/** The card's and the Agents view's way to the profile; null outside the window (the tour, a picture). */
export const useAgentProfileNav = (): AgentProfileNav | null => useContext(NavContext);

export interface AgentProfileHostProps {
  route: Route;
  go: (route: Route) => void;
  /** Back to the screen under this one (app/focus.ts `closeTo`): a phone's Back. */
  close: (route: Route) => void;
  machines: MachinesModel;
  /** The window's rows: the profile's Threads. */
  rows: readonly InboxListRow[];
  phone: boolean;
  /** A narrow window: the profile covers the list, and leads with the way back to it. */
  stacked: boolean;
  /** The list's title, the way back's words ("‹ harbor-web"). */
  backLabel: string;
  onMessage: (session: string, opener: HTMLElement) => void;
  children: ReactNode;
}

/** The list's place with no thread and no profile: the screen a profile opens over and closes back to. */
const listOf = (route: Route): Route => ({ page: 'inbox', project: route.project, machine: route.machine, agent: route.agent, tag: route.tag, thread: null });

export function AgentProfileHost({ route, go, close, machines, rows, phone, stacked, backLabel, onMessage, children }: AgentProfileHostProps) {
  const inbox = route.page === 'inbox' && !route.reviews;
  const filter = inbox ? (route.agent ?? null) : null;
  const open = inbox && !route.thread ? (route.profile ?? null) : null;
  const latest = useRef({ route, go, close });
  latest.current = { route, go, close };
  const toggle = useCallback((id: string) => {
    const { route: now, go: push, close: back } = latest.current;
    if (now.profile === id && !now.thread) back(listOf(now));
    else push({ ...listOf(now), profile: id });
  }, []);
  const value = useMemo(() => ({ filter, open, machines, toggle }), [filter, open, machines, toggle]);
  return (
    <NavContext.Provider value={value}>
      {children}
      {open && (
        <AgentProfile
          key={open}
          id={open}
          machines={machines}
          rows={rows}
          phone={phone}
          stacked={stacked}
          backLabel={backLabel}
          onClose={() => close(listOf(route))}
          onOpenThread={(threadId) => go({ ...listOf(route), thread: threadId })}
          onMessage={onMessage}
        />
      )}
    </NavContext.Provider>
  );
}
