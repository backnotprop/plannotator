/**
 * Swarm across linked computers, on the asking computer's side (docs/agent-guides/inbox-swarm.md, "Linked computers"):
 *
 * - The far joins: which swarm (thread, on which computer) each session here joined there, so `say`, `doing` and
 *   `leave` without `--thread` find it after this Inbox restarts. One small file in the Inbox's data
 *   (`swarm-far-joins.json`, 0600), written whole to a temp file and renamed over the old one.
 * - A held `say`: while the thread's computer is away, the words wait in the outbox as this Inbox's own write (as a far
 *   reply does, inbox-mcp-far-reply.ts) and go once when it is back. The key rides the write, so a send the thread's
 *   computer already took is written there once (store.ts `writeGhostMessage`).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OutboxEntry } from "./inbox-outbox";

export interface SwarmFarPlace {
  machine: string;
  thread: string;
}

export interface SwarmFarJoins {
  get: (session: string) => SwarmFarPlace | null;
  set: (session: string, place: SwarmFarPlace) => void;
  drop: (session: string) => void;
}

const MACHINE_ID = /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{1,80}$/;

/** The far joins of the Inbox whose store lives in `storeDir`. A file that does not read is an empty one. */
export function createSwarmFarJoins(storeDir: string): SwarmFarJoins {
  const file = join(storeDir, "swarm-far-joins.json");
  const joins = new Map<string, SwarmFarPlace>();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { joins?: Record<string, unknown> };
    for (const [session, place] of Object.entries(raw.joins ?? {})) {
      const p = place as Partial<SwarmFarPlace> | null;
      if (p && typeof p.machine === "string" && MACHINE_ID.test(p.machine) && typeof p.thread === "string" && MESSAGE_ID.test(p.thread)) joins.set(session, { machine: p.machine, thread: p.thread });
    }
  } catch {
    // None yet.
  }
  const save = () => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, joins: Object.fromEntries(joins) })}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      // Kept in memory: the agent can still name the thread with --thread.
    }
  };
  return {
    get: (session) => joins.get(session) ?? null,
    set: (session, place) => {
      const was = joins.get(session);
      if (was && was.machine === place.machine && was.thread === place.thread) return;
      joins.set(session, { machine: place.machine, thread: place.thread });
      save();
    },
    drop: (session) => {
      if (joins.delete(session)) save();
    },
  };
}

/** How a held `say` stands once its wait is over: answered there, refused there, or still waiting for that computer. */
export type SwarmHeldSay = { kind: "answered"; status: number; json: Record<string, unknown> | null } | { kind: "refused"; status: number; json: Record<string, unknown> | null } | { kind: "waiting" };

/**
 * `say` to a swarm on `machine`, held in the outbox (`hold`: the machines' `holdWrite` for the door's `swarm` route).
 * Null when that computer is not linked any more.
 */
export async function holdSwarmSay(
  hold: (machine: string, body: Record<string, unknown>, thread: string) => Promise<OutboxEntry | null> | null,
  dismiss: (key: string) => void,
  machine: string,
  thread: string,
  body: Record<string, unknown>,
): Promise<SwarmHeldSay | null> {
  const key = `swarm-say:${randomUUID()}`;
  const held = hold(machine, { ...body, idempotency_key: key }, thread);
  if (!held) return null;
  const entry = await held;
  const json = entry?.answer && typeof entry.answer === "object" && !Array.isArray(entry.answer) ? (entry.answer as Record<string, unknown>) : null;
  if (entry?.state === "delivered") return { kind: "answered", status: entry.status ?? 200, json };
  if (entry && (entry.state === "refused" || entry.state === "dropped" || entry.state === "cancelled")) {
    // The agent is told now: the window has nothing to add.
    dismiss(key);
    return { kind: "refused", status: entry.status && entry.status >= 400 ? entry.status : 409, json };
  }
  return { kind: "waiting" };
}
