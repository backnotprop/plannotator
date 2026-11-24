/**
 * Who ships a pull request (approval "inbox-ship-mode"): the session Ship was given, never the thread's latest agent.
 * A thread can hold several agents (a reviewer, a hand-off, a tagged session); every Ship note and the stop line go
 * to the shipping one, only its `thread_pulls` `ship` calls change the ship, and Stuck's "ended" reads its session.
 *
 * A new session (Ship's "New … session" rows) has a placeholder session until it is known: the session the ship's own
 * launch (`launch_id`, on the message that carried the instruction) reports (core `inboxLaunchedSession`), or the
 * session that message was delivered to. The watch then binds the ship to it. No other session ever binds it: not the
 * thread's other agents, not the one an earlier ship of the thread was given.
 */
import type { InboxShip } from "@plannotator/core/inbox-pull-handoff";
import { inboxLaunchedSession } from "@plannotator/core/inbox-run-line";
import type { InboxMessage } from "@plannotator/core/inbox-types";

type Message = Pick<InboxMessage, "id" | "author" | "to" | "launch" | "wakes" | "delivery">;

export interface InboxShipAgentDeps {
  message(id: string): Message | null | undefined;
  threadMessageIds(threadId: string): readonly string[];
  /** A session that polls now (`live.isSessionLive`). Absent: none is called ended. */
  sessionLive?: (session: string) => boolean;
  /** A launched thread whose session did not start, or ended and is not restarted (`launch.didNotStart`). */
  launchDead?: (threadId: string) => boolean;
}

type Ship = Pick<InboxShip, "agent" | "instruction_id" | "thread_id" | "bound" | "launch_id">;

/** A session the Inbox made up for a launch that has not started: no agent's. */
const placeholder = (session: string | null | undefined): boolean => !session || session.startsWith("launch:");

/**
 * The sessions an unbound ship may bind to: the one its own launch reported (the instruction message's launch, the one
 * tied to the ship), then the one its instruction was delivered to (by that session's own read, not another agent's).
 * Empty while neither is known.
 */
export function shipBinds(deps: Pick<InboxShipAgentDeps, "message">, ship: Ship): string[] {
  const carried = ship.instruction_id ? deps.message(ship.instruction_id) : null;
  if (!carried) return [];
  const tied = carried.launch && (ship.launch_id ?? carried.launch.id) === carried.launch.id;
  const launched = tied ? inboxLaunchedSession(carried) : null;
  const delivered = carried.delivery && !carried.delivery.read_by ? carried.delivery.session : null;
  return [...new Set([launched, delivered].filter((s): s is string => !placeholder(s)))];
}

/**
 * Why the launch tied to an unbound ship will not report a session: its own error's words, or that it was removed.
 * Null while it may still start, when it started, and for a ship no launch made.
 */
export function shipLaunchFailed(deps: Pick<InboxShipAgentDeps, "message">, ship: Ship): string | null {
  if (ship.bound) return null;
  const carried = ship.instruction_id ? deps.message(ship.instruction_id) : null;
  const launch = carried?.launch;
  if (!carried || !launch || (ship.launch_id ?? launch.id) !== launch.id || !placeholder(inboxLaunchedSession(carried))) return null;
  if (launch.error) return launch.error.text.trim() || "its launch failed";
  if (launch.deleted_at) return "its launch was removed";
  return null;
}

/**
 * The shipping session as it stands; null when none is known yet (nothing is sent to anyone else: its notes wait). A
 * bound ship's is its record's (the person's choice, or the session it was bound to); else the first of `shipBinds`.
 */
export function shipShipper(deps: InboxShipAgentDeps, ship: Ship): { host: string; session: string } | null {
  const carried = ship.instruction_id ? deps.message(ship.instruction_id) : null;
  const host = ship.agent.host ?? carried?.to?.host ?? null;
  const session = ship.bound ? ship.agent.session : (shipBinds(deps, ship)[0] ?? null);
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
