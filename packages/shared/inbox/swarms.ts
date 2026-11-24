/**
 * Plannotator Inbox: swarm threads (docs/agent-guides/inbox-compose.md, "Swarm").
 *
 *   inbox/swarms.json   { v: 1, swarms: [{ thread_id, on, started_at, changed_at, doing: [{ session, text, at }] }] },
 *                       0600, written whole (temp, then rename)
 *
 * A file outside the store's JSONL, like snoozes: the person's switch and each agent's last line change often and are
 * not messages, so they take no seq and never move an agent's cursor or enter search. It lives on the computer that
 * holds the thread. No agent's state is kept here: that is read from its live connection when the view is made
 * (`inboxSwarmMembers`, @plannotator/core/inbox-swarm).
 */

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxId, type InboxSwarm } from "@plannotator/core/inbox-types";
import { inboxSwarmDoingClean } from "@plannotator/core/inbox-swarm";
import { InboxError } from "./schema";

export const INBOX_SWARMS_FILE = "swarms.json";

/** The most lines one swarm keeps (one per session; the oldest goes first). */
export const INBOX_SWARM_DOING_KEPT = 64;

type Entry = InboxSwarm & { thread_id: string };

const fileOf = (dir: string) => join(dir, INBOX_SWARMS_FILE);

/** The swarms on disk. A file that does not parse reads as none; a bad or repeated entry is skipped. */
export function readInboxSwarms(dir: string): Entry[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(fileOf(dir), "utf8"));
  } catch {
    return [];
  }
  const file = value as { v?: unknown; swarms?: unknown } | null;
  if (!file || typeof file !== "object" || file.v !== 1 || !Array.isArray(file.swarms)) return [];
  const out: Entry[] = [];
  for (const raw of file.swarms as unknown[]) {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || !isInboxId("msg", entry.thread_id) || out.some((e) => e.thread_id === entry.thread_id)) continue;
    if (typeof entry.on !== "boolean" || typeof entry.started_at !== "string" || typeof entry.changed_at !== "string") continue;
    const doing: InboxSwarm["doing"] = [];
    for (const d of Array.isArray(entry.doing) ? (entry.doing as unknown[]) : []) {
      const line = d as Record<string, unknown> | null;
      const text = inboxSwarmDoingClean(line?.text);
      if (!line || typeof line.session !== "string" || !line.session || !text || typeof line.at !== "string") continue;
      if (!doing.some((x) => x.session === line.session)) doing.push({ session: line.session, text, at: line.at });
    }
    out.push({ thread_id: entry.thread_id, on: entry.on, started_at: entry.started_at, changed_at: entry.changed_at, doing });
  }
  return out;
}

function newerOnDisk(dir: string): boolean {
  try {
    const file = JSON.parse(readFileSync(fileOf(dir), "utf8")) as { v?: unknown } | null;
    return !!file && typeof file === "object" && typeof file.v === "number" && file.v > 1;
  } catch {
    return false;
  }
}

/** Every swarm thread of one Inbox: read once, written whole on each change. */
export class InboxSwarms {
  private entries: Entry[];
  /** Moves on every change (the window's thread signature reads it). */
  revision = 0;

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.entries = readInboxSwarms(dir);
  }

  /** The thread's swarm, on or off; null for a thread that never was one. */
  get(threadId: string): InboxSwarm | null {
    const entry = this.entries.find((e) => e.thread_id === threadId);
    return entry ? { on: entry.on, started_at: entry.started_at, changed_at: entry.changed_at, doing: entry.doing.map((d) => ({ ...d })) } : null;
  }

  /** Turns swarm on or off for a thread (a first `on` starts its record). Turning off a thread that never was one writes nothing. */
  setOn(threadId: string, on: boolean): InboxSwarm | null {
    const at = this.now().toISOString();
    const entry = this.entries.find((e) => e.thread_id === threadId);
    if (!entry) {
      if (!on) return null;
      this.entries.push({ thread_id: threadId, on: true, started_at: at, changed_at: at, doing: [] });
    } else if (entry.on !== on) {
      entry.on = on;
      entry.changed_at = at;
    } else return this.get(threadId);
    this.save();
    return this.get(threadId);
  }

  /**
   * One agent's line (the `swarm` action's `doing`): replaces its last. Kept on any thread, on or off: the line is
   * there for whoever reads the view. Returns the thread's swarm after it.
   */
  say(threadId: string, session: string, text: unknown): InboxSwarm {
    const line = inboxSwarmDoingClean(text);
    if (!line) throw new InboxError("validation_error", "doing: one line of words.", { field: "doing" });
    if (!session) throw new InboxError("validation_error", "This call names no agent session, so its line has no one to belong to.", { field: "agent_session" });
    const at = this.now().toISOString();
    let entry = this.entries.find((e) => e.thread_id === threadId);
    if (!entry) {
      entry = { thread_id: threadId, on: false, started_at: at, changed_at: at, doing: [] };
      this.entries.push(entry);
    }
    entry.doing = [...entry.doing.filter((d) => d.session !== session), { session, text: line, at }].slice(-INBOX_SWARM_DOING_KEPT);
    this.save();
    return this.get(threadId)!;
  }

  /** A deleted thread leaves the file. */
  forget(threadId: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.thread_id !== threadId);
    if (this.entries.length !== before) this.save();
  }

  private save(): void {
    if (newerOnDisk(this.dir)) throw new InboxError("swarms_newer", "A newer Plannotator keeps swarm threads here: update this one to change them.");
    const path = fileOf(this.dir);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, swarms: this.entries })}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    this.revision++;
  }
}
