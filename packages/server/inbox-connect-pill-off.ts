/**
 * The sidebar's Connect agent pill switches itself off once (the owner, 2026-11-23: "It should leave the sidebar …
 * after agents are connected … Or after one day of use when the person's clearly using it. And it should just auto
 * turn off as the sidebar switch … So if the user ever wants it back, they can just turn it back on.").
 *
 * The rule: once an agent has written to this Inbox and CONNECT_PILL_OFF_AFTER_MS has passed since the first one did,
 * the server turns the `copy-prompt` item's "Show in sidebar" off, exactly as the Customize panel's switch would (a
 * saved layout, `inboxSidebarRev` + 1, `event: sidebar` to every window, the phone's included), and stamps
 * `inboxSidebarConnectOff` (state.json). The stamp makes it once per person: it never runs again, so a pill turned
 * back on stays on, and a preset picked later (Minimal hides it; Default shows it) is never undone. An item already
 * hidden then (Minimal, or the person's own switch) is only stamped; nothing is saved.
 *
 * "The first agent connected" is the store's oldest agent message (an agent that connected and wrote: a session's
 * ask, a launched agent's first line, a routine's run). No record keeps the moment an agent connected; the agents
 * file's `first_connected_at` is the Inbox writing MCP entries into agent configs at start, which can happen with no
 * agent ever writing. A thread deleted later only moves that time later, never brings the pill back.
 */
import { INBOX_SIDEBAR_DEFAULT, inboxSidebarSetShown, inboxSidebarShown, type InboxSidebarLayout } from "@plannotator/core/inbox-sidebar";
import { loadConfig, saveConfig, type PlannotatorConfig } from "@plannotator/shared/config";
import { inboxSidebarState } from "./inbox-sidebar-save";

/** A day after the first agent connected: never on the day it connects. */
export const CONNECT_PILL_OFF_AFTER_MS = 24 * 60 * 60 * 1000;

type Saved = PlannotatorConfig["inboxSidebarConnectOff"];

/** Due at `now`: never switched off before (any stamp at all, even one this build cannot read, means it ran) and a day since the first agent. */
export function connectPillOffDue(saved: unknown, firstAgentAt: string | null, now: number): boolean {
  if (saved !== undefined) return false;
  const first = firstAgentAt ? Date.parse(firstAgentAt) : Number.NaN;
  return Number.isFinite(first) && now - first >= CONNECT_PILL_OFF_AFTER_MS;
}

/**
 * The person saved a sidebar layout (the Sidebar tip's `customized`): a saved layout counts, except the one the
 * switch-off saved when it was the first ever (`first`) and nothing was saved after it (`rev` still the count).
 */
export function sidebarCustomizedByPerson(config: Pick<PlannotatorConfig, "inboxSidebar" | "inboxSidebarConnectOff">, rev: number): boolean {
  const off = config.inboxSidebarConnectOff;
  if (off?.first === true && typeof off.rev === "number" && off.rev === rev) return false;
  return rev > 0 || config.inboxSidebar !== undefined;
}

/** The oldest agent message in the store (each thread's first agent message; a thread's ids are in seq order). */
export function firstAgentMessageAt(store: {
  threadIds(): readonly string[];
  threadMessageIds(threadId: string): readonly string[];
  message(id: string): { author: { kind: string }; created_at: string } | null;
}): string | null {
  let oldest = Number.POSITIVE_INFINITY;
  for (const threadId of store.threadIds()) {
    for (const id of store.threadMessageIds(threadId)) {
      const message = store.message(id);
      if (message?.author.kind !== "agent") continue;
      const at = Date.parse(message.created_at);
      if (Number.isFinite(at) && at < oldest) oldest = at;
      break;
    }
  }
  return Number.isFinite(oldest) ? new Date(oldest).toISOString() : null;
}

export interface ConnectPillOff {
  /** An agent message was stored (its `created_at`): the first one starts the day. */
  heard(at: string): void;
  /** Switch it off now when it is due (a settings read, an agent message). Never throws; true when it saved a layout. */
  check(): boolean;
}

/**
 * The server's switch-off. `firstAgentAt` walks the store, asked only until the first agent is known (then kept in
 * memory). `saveSidebar` is the Customize panel's save (inbox.ts: validated, the items of an off capability left out,
 * every window told).
 */
export function createConnectPillOff(deps: {
  firstAgentAt: () => string | null;
  saveSidebar: (layout: InboxSidebarLayout) => { rev: number };
  now?: () => number;
}): ConnectPillOff {
  const now = deps.now ?? Date.now;
  let first: string | null = null;
  let done = false;
  const earlier = (at: string) => {
    if (first === null || Date.parse(at) < Date.parse(first)) first = at;
  };
  return {
    heard(at) {
      if (!done && Number.isFinite(Date.parse(at))) earlier(at);
    },
    check() {
      if (done) return false;
      const config = loadConfig();
      if (config.inboxSidebarConnectOff !== undefined) {
        done = true;
        return false;
      }
      if (first === null) {
        const found = deps.firstAgentAt();
        if (found) earlier(found);
      }
      const at = now();
      if (!connectPillOffDue(config.inboxSidebarConnectOff, first, at)) return false;
      try {
        const state = inboxSidebarState();
        const layout = state.sidebar ?? INBOX_SIDEBAR_DEFAULT;
        const stamp: NonNullable<Saved> = { at: new Date(at).toISOString() };
        let saved = false;
        if (inboxSidebarShown(layout, "copy-prompt")) {
          const firstSave = state.rev === 0 && config.inboxSidebar === undefined;
          stamp.rev = deps.saveSidebar(inboxSidebarSetShown(layout, "copy-prompt", false)).rev;
          if (firstSave) stamp.first = true;
          saved = true;
        }
        // Not written (a read-only data dir): tried again at the next check, which finds the item already hidden.
        done = saveConfig({ inboxSidebarConnectOff: stamp });
        return saved;
      } catch {
        // The layout could not be saved (config.json unreadable): nothing changed; the next check tries again.
        return false;
      }
    },
  };
}
