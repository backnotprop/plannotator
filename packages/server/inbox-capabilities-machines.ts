/**
 * Settings → Capabilities on a linked computer (docs/agent-guides/inbox-machines.md, "Capabilities on a linked
 * computer"): the forward's `GET capabilities`. While that computer answers, its switches as it says them; while it is
 * away, slow or failing, the last it gave (kept in memory, as its routines are, so a reload of the page keeps its group),
 * marked `away` with when it gave them. Either way, a switch the person turned that waits in this Inbox's outbox for it
 * is shown as turned and named in `held`, read from the outbox each time, until that computer takes or refuses it.
 * Never read from there: the forward's away answer (503), as before.
 */
import { inboxCapabilitySwitchesOf, type InboxCapabilitySwitches, type InboxCapabilitySwitchKey } from "@plannotator/core/inbox-types";
import type { HeldRoutineWrite } from "./inbox-scheduled-machines";
import { FAR_ROUTINES_WAIT_MS, type RoutinesPeer } from "./inbox-scheduled-machines";

/** The forward's answer to the window. */
export interface FarCapabilitiesAnswer {
  capabilities: InboxCapabilitySwitches;
  /** The switches are the last it gave, not read now. */
  away: boolean;
  /** When it last gave them (ISO). */
  read_at: string;
  /** The switches turned here that wait for it, shown as turned. */
  held: InboxCapabilitySwitchKey[];
}

/** Switches with the person's held turns laid on, in the order they were made, and which those are. */
export function capabilitiesWithHeld(switches: InboxCapabilitySwitches, held: readonly HeldRoutineWrite[]): { capabilities: InboxCapabilitySwitches; held: InboxCapabilitySwitchKey[] } {
  const out: InboxCapabilitySwitches = { ...switches };
  const keys = new Set<InboxCapabilitySwitchKey>();
  for (const write of held) {
    if (write.route !== "capabilities") continue;
    for (const [key, value] of Object.entries(inboxCapabilitySwitchesOf(write.body)) as [InboxCapabilitySwitchKey, { on: boolean }][]) {
      out[key] = value;
      keys.add(key);
    }
  }
  return { capabilities: out, held: [...keys] };
}

export function createFarCapabilities(heldOn: (machine: string) => readonly HeldRoutineWrite[], now: () => Date = () => new Date()) {
  const kept = new Map<string, { capabilities: InboxCapabilitySwitches; read_at: string }>();
  const answer = (machine: string, one: { capabilities: InboxCapabilitySwitches; read_at: string }, away: boolean): Response =>
    Response.json({ ...capabilitiesWithHeld(one.capabilities, heldOn(machine)), away, read_at: one.read_at } satisfies FarCapabilitiesAnswer);
  return {
    /** `offline`: the forward's away answer, for a computer never read. */
    async read(peer: Pick<RoutinesPeer, "id" | "state" | "request">, offline: () => Response): Promise<Response> {
      const last = kept.get(peer.id);
      const away = () => (last ? answer(peer.id, last, true) : offline());
      if (peer.state !== "online") return away();
      try {
        const response = await peer.request("capabilities", "", { method: "GET", headers: {}, timeoutMs: FAR_ROUTINES_WAIT_MS });
        // An older door (no such route), or a refusal: its words, as it said them.
        if (!response.ok) return response.status >= 500 ? away() : Response.json(await response.json().catch(() => ({})), { status: response.status });
        const body = (await response.json().catch(() => null)) as { capabilities?: unknown } | null;
        const next = { capabilities: inboxCapabilitySwitchesOf(body?.capabilities), read_at: now().toISOString() };
        kept.set(peer.id, next);
        return answer(peer.id, next, false);
      } catch {
        return away();
      }
    },
    /** A computer unlinked: its switches go. */
    forget(machine: string): void {
      kept.delete(machine);
    },
  };
}
