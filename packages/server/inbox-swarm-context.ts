/**
 * The Inbox's side of Swarm, put together for inbox.ts (inbox-swarm-route.ts says what each route does): the live state
 * of each member (working while its connection is busy, idle while it waits, waiting when the thread waits on the
 * person after its words), and a linked computer that holds a thread this Inbox does not have.
 */

import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { SwarmLiveState } from "@plannotator/shared/inbox/swarm";
import type { InboxMachines } from "./inbox-machines";
import { FAR_SWARM_ROUTE, type SwarmRouteContext } from "./inbox-swarm-route";
import { createSwarmFarJoins, holdSwarmSay } from "./inbox-swarm-far";

/** How long a linked computer has to answer a swarm command. */
const FAR_SWARM_WAIT_MS = 8_000;

export function inboxSwarmContext(deps: {
  store: InboxStore;
  on: () => boolean;
  /** A session's connection as this Inbox knows it (here, or on a linked computer). */
  connectionOf: (session: string) => { busy: boolean | null } | null;
  machines: () => InboxMachines | null | undefined;
  farWakes: { placeOf: (id: string) => { machine: string; thread_id: string } | null };
  ownSession: (session: string) => boolean;
  /** This computer's connection of `session` wakes it with the person's reply. */
  wakes?: (session: string) => boolean;
  tagOf?: SwarmRouteContext["tagOf"];
  serverSession?: string;
}): SwarmRouteContext {
  const { store } = deps;
  const joins = createSwarmFarJoins(store.dir);
  const live: SwarmLiveState = (member, threadId) => {
    const row = store.listRow(threadId);
    if (row?.waiting_on_person) {
      const ids = store.threadMessageIds(threadId);
      for (let i = ids.length - 1; i >= 0; i--) {
        const message = store.message(ids[i]!);
        if (message?.author.kind !== "agent") continue;
        if (message.author.session === member.session) return "waiting";
        break;
      }
    }
    const busy = deps.connectionOf(member.session)?.busy;
    return busy === true ? "working" : busy === false ? "idle" : null;
  };
  return {
    store,
    on: deps.on,
    live,
    ownSession: deps.ownSession,
    wakes: deps.wakes,
    tagOf: deps.tagOf,
    serverSession: deps.serverSession,
    far: {
      placeOf: async (ref) => {
        const handed = deps.farWakes.placeOf(ref);
        if (handed) return handed;
        const machines = deps.machines();
        if (!machines) return null;
        const listed = machines.peerLinks().find((peer) => peer.list?.rows.some((row) => row.thread_id === ref));
        if (listed) return { machine: listed.id, thread_id: ref };
        const found = await machines.readThread({ message_id: ref, limit: 1 }).catch(() => null);
        return found ? { machine: found.machine, thread_id: found.answer.thread_id } : null;
      },
      nameOf: (machine) => deps.machines()?.nameOf(machine) ?? null,
      joins,
      // As a far reply (inbox-mcp-far-reply.ts): this Inbox's own held write, its refusal a notice under that thread.
      holdSay: (machine, thread, body) =>
        holdSwarmSay(
          (m, b, t) => deps.machines()?.holdWrite(m, FAR_SWARM_ROUTE, b, t, FAR_SWARM_WAIT_MS, { notify: true }) ?? null,
          (key) => deps.machines()?.dismissHeld(key),
          machine,
          thread,
          body,
        ),
      ask: async (machine, body) => {
        const peer = deps.machines()?.peerLinks().find((p) => p.id === machine);
        const name = deps.machines()?.nameOf(machine) ?? "The other computer";
        if (!peer) return { status: 409, json: { code: "machine_offline", error: `${name} is not linked any more.` } };
        try {
          const response = await peer.request(FAR_SWARM_ROUTE, "", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), timeoutMs: FAR_SWARM_WAIT_MS });
          return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> | null };
        } catch {
          return { status: 409, json: { code: "machine_offline", error: `${name} cannot be reached now: the swarm lives there. Try again when ${name} is back.` } };
        }
      },
    },
  };
}
