/**
 * Who ships a pull request (approval "inbox-ship-mode"): the session Ship was given, never the thread's latest agent.
 * A thread can hold several agents (a reviewer, a hand-off, a tagged session); every Ship note and the stop line go
 * to the shipping one, only its `thread_pulls` `ship` calls change the ship, and Stuck's "ended" reads its session.
 *
 * A new session (Ship's "New … session" rows) has a placeholder session until its launch starts: it is read from the
 * message that carried the instruction (core `inboxLaunchedSession`), and the watch records it on the ship.
 */
import type { InboxShip } from "@plannotator/core/inbox-ship";
import { inboxLaunchedSession } from "@plannotator/core/inbox-run-line";
import type { InboxMessage } from "@plannotator/core/inbox-types";

type Message = Pick<InboxMessage, "id" | "author" | "to" | "launch" | "wakes">;

export interface InboxShipAgentDeps {
  message(id: string): Message | null | undefined;
  threadMessageIds(threadId: string): readonly string[];
  /** A session that polls now (`live.isSessionLive`). Absent: none is called ended. */
  sessionLive?: (session: string) => boolean;
  /** A launched thread whose session did not start, or ended and is not restarted (`launch.didNotStart`). */
  launchDead?: (threadId: string) => boolean;
}

type Ship = Pick<InboxShip, "agent" | "instruction_id" | "thread_id" | "bound">;

/**
 * The shipping session as it stands; null when Ship named none (nothing is sent to anyone else). A bound ship's is its
 * record's (the person's choice, or the session that logged its steps); else the one its launch started.
 */
export function shipShipper(deps: InboxShipAgentDeps, ship: Ship): { host: string; session: string } | null {
  const carried = ship.instruction_id ? deps.message(ship.instruction_id) : null;
  const launched = !ship.bound && carried?.launch ? inboxLaunchedSession(carried) : null;
  const session = launched ?? ship.agent.session;
  const host = ship.agent.host ?? carried?.to?.host ?? null;
  return session && host ? { host, session } : null;
}

/**
 * The shipping session ended: one that wakes (its own last message here said so, or it was handed the thread live)
 * and polls no more. A new session the Inbox started is restarted by its own notes, so only a launched thread whose
 * session is dead counts.
 */
export function shipSessionEnded(deps: InboxShipAgentDeps, ship: Ship): boolean {
  const who = shipShipper(deps, ship);
  if (!who) return false;
  const carried = ship.instruction_id ? deps.message(ship.instruction_id) : null;
  if (carried?.launch) return carried.id === ship.thread_id && deps.launchDead?.(ship.thread_id) === true;
  const ids = deps.threadMessageIds(ship.thread_id);
  let wakes = true;
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const m = deps.message(ids[i]!);
    if (m?.author.kind === "agent" && m.author.session === who.session) {
      wakes = m.wakes === true;
      break;
    }
  }
  return wakes && !!deps.sessionLive && !deps.sessionLive(who.session);
}
