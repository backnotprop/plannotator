/**
 * Routines across linked computers (docs/agent-guides/inbox-routines.md, "Linked machines"). A routine still lives and
 * runs on the computer that made it; the window's merged read (`GET /api/inbox/scheduled?machines=1`) lists every
 * linked computer's routines beside this one's, each row with `machine`, read through that computer's door
 * (`GET scheduled`, machine only). An away computer's rows are the last ones it gave (kept in memory, as its thread
 * rows are); a computer without the `routines` mark (an older Plannotator) is never asked and lists nothing.
 *
 * A change the person made that waits in this Inbox's outbox for that computer (an edit, a turn, a delete, a bring back)
 * is laid on its rows until that computer takes or refuses it (`heldOn`), read from the outbox each time, so a reload
 * of the page shows it too.
 */
import { inboxScheduledPreview } from "@plannotator/core/inbox-scheduled";
import type { InboxScheduledRow, InboxScheduledSchedule } from "@plannotator/core/inbox-scheduled-types";

/** The mark a linked computer's list carries when its door answers its routines (`INBOX_LINKED_MARKS`). */
export const ROUTINES_MARK = "routines";

/** How long the merged read waits for one computer before it shows what that computer last gave. */
export const FAR_ROUTINES_WAIT_MS = 2_500;

/** What the merged read needs of one linked computer (a PeerLink). */
export interface RoutinesPeer {
  id: string;
  state: string;
  list: { marks: readonly string[] } | null;
  request(route: string, search: string, init: { method: "GET"; headers: Record<string, string>; timeoutMs?: number }): Promise<Response>;
}

/** One linked computer's routines, as the merged read answers them. */
export interface FarRoutines {
  machine: string;
  /** Its Routines switch is on. */
  on: boolean;
  /** "Start agents from New message" is on there. */
  launch_on: boolean;
  /** Its rows are the last it gave, not read now (away, slow, or failing). */
  away: boolean;
  /** When it last gave them (ISO). */
  read_at: string;
  rows: (InboxScheduledRow & { machine: string })[];
}

type Kept = Omit<FarRoutines, "away">;

/** A write waiting in the outbox for that computer, as the overlay needs it (an OutboxEntry). */
export interface HeldRoutineWrite {
  route: string;
  body: Record<string, unknown>;
  queued_at: string;
}

const SCHEDULED_ID = /^sch_[A-Za-z0-9_-]{1,80}$/;
const HELD_ROUTE = /^scheduled\/(sch_[A-Za-z0-9_-]{1,80})(?:\/(on|off|delete|restore))?$/;
/** The fields an edit (`POST scheduled/:id`) changes that a row shows. */
const EDIT_FIELDS = ["name", "prompt", "schedule", "if_missed", "folder", "agent", "model", "effort", "attachments"] as const;

/**
 * Rows with the person's held writes laid on, in the order they were made: an edit's fields (and its schedule's words), a
 * turn on or off, a delete (the row leaves) and a bring back (it returns as it was). A held write is the person's, so its
 * row says what they did, not what that computer last said.
 */
export function withHeld<R extends InboxScheduledRow>(rows: readonly R[], held: readonly HeldRoutineWrite[], now: Date = new Date()): R[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const gone = new Set<string>();
  for (const write of held) {
    const m = HELD_ROUTE.exec(write.route);
    const row = m ? byId.get(m[1]!) : undefined;
    if (!m || !row) continue;
    const action = m[2];
    if (action === "delete") gone.add(row.id);
    else if (action === "restore") gone.delete(row.id);
    else if (action === "on" || action === "off") {
      const on = action === "on";
      byId.set(row.id, { ...row, enabled: on, state: row.state === "running" || row.state === "done" ? row.state : on ? "on" : "off", updated_at: later(row.updated_at, write.queued_at) });
    } else {
      const change: Record<string, unknown> = {};
      for (const field of EDIT_FIELDS) if (write.body[field] !== undefined) change[field] = write.body[field];
      if (Object.keys(change).length === 0) continue;
      const next = { ...row, ...change, updated_at: later(row.updated_at, write.queued_at) } as R;
      if (change.schedule !== undefined) {
        const preview = inboxScheduledPreview((change.schedule ?? null) as InboxScheduledSchedule, now);
        if (preview.ok) Object.assign(next, { schedule_words: preview.schedule_words, tz_short: preview.tz_short, next_run: next.state === "off" ? null : preview.next_run });
      }
      byId.set(row.id, next);
    }
  }
  return [...byId.values()].filter((row) => !gone.has(row.id));
}

const later = (a: string, b: string) => (b > a ? b : a);

/** A far answer's rows, each a routine with a plain id, named as that computer's. */
export function farRoutineRows(machine: string, input: unknown): (InboxScheduledRow & { machine: string })[] {
  const rows = (input as { scheduled?: unknown } | null)?.scheduled;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string" && SCHEDULED_ID.test((row as { id: string }).id) && typeof (row as { name?: unknown }).name === "string" ? [{ ...(row as InboxScheduledRow), machine }] : []));
}

/**
 * The linked computers' routines, each read now while it answers, else the last it gave; `heldOn(machine)`: the writes
 * waiting in the outbox for it, laid on its rows (`withHeld`).
 */
export function createFarRoutines(peers: () => Iterable<RoutinesPeer>, heldOn: (machine: string) => readonly HeldRoutineWrite[] = () => [], now: () => Date = () => new Date()) {
  const kept = new Map<string, Kept>();
  const shown = (one: Kept, away: boolean): FarRoutines => {
    const held = heldOn(one.machine);
    return { ...one, away, rows: held.length > 0 ? withHeld(one.rows, held, now()) : one.rows };
  };
  const readOne = async (peer: RoutinesPeer): Promise<FarRoutines | null> => {
    const held = kept.get(peer.id) ?? null;
    const away = (): FarRoutines | null => (held ? shown(held, true) : null);
    if (peer.state !== "online") return away();
    try {
      const response = await peer.request("scheduled", "", { method: "GET", headers: {}, timeoutMs: FAR_ROUTINES_WAIT_MS });
      const body = (await response.json().catch(() => null)) as { code?: unknown; launch_on?: unknown } | null;
      const read_at = now().toISOString();
      let next: Kept;
      if (response.status === 404 && body?.code === "routines_off") next = { machine: peer.id, on: false, launch_on: true, read_at, rows: [] };
      else if (response.ok) next = { machine: peer.id, on: true, launch_on: body?.launch_on !== false, read_at, rows: farRoutineRows(peer.id, body) };
      // An older door (no such route) lists nothing; any other failure shows the last rows.
      else if (response.status === 404) return null;
      else return away();
      kept.set(peer.id, next);
      return shown(next, false);
    } catch {
      return away();
    }
  };
  return {
    /** Every linked computer that takes routines, in link order; one that never answered is left out. */
    async read(): Promise<FarRoutines[]> {
      const asked = [...peers()].filter((peer) => peer.list?.marks.includes(ROUTINES_MARK));
      const known = new Set(asked.map((peer) => peer.id));
      for (const id of kept.keys()) if (!known.has(id)) kept.delete(id);
      return (await Promise.all(asked.map(readOne))).filter((one): one is FarRoutines => one !== null);
    },
  };
}
