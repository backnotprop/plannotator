/**
 * Routines across linked computers (docs/agent-guides/inbox-routines.md, "Linked machines"). A routine still lives and
 * runs on the computer that made it; the window's merged read (`GET /api/inbox/scheduled?machines=1`) lists every
 * linked computer's routines beside this one's, each row with `machine`, read through that computer's door
 * (`GET scheduled`, machine only). An away computer's rows are the last ones it gave (kept in memory, as its thread
 * rows are); a computer without the `routines` mark (an older Plannotator) is never asked and lists nothing.
 */
import type { InboxScheduledRow } from "@plannotator/core/inbox-scheduled-types";

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
  rows: (InboxScheduledRow & { machine: string })[];
}

type Kept = Omit<FarRoutines, "away">;

const SCHEDULED_ID = /^sch_[A-Za-z0-9_-]{1,80}$/;

/** A far answer's rows, each a routine with a plain id, named as that computer's. */
export function farRoutineRows(machine: string, input: unknown): (InboxScheduledRow & { machine: string })[] {
  const rows = (input as { scheduled?: unknown } | null)?.scheduled;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string" && SCHEDULED_ID.test((row as { id: string }).id) && typeof (row as { name?: unknown }).name === "string" ? [{ ...(row as InboxScheduledRow), machine }] : []));
}

/** The linked computers' routines, each read now while it answers, else the last it gave. */
export function createFarRoutines(peers: () => Iterable<RoutinesPeer>) {
  const kept = new Map<string, Kept>();
  const readOne = async (peer: RoutinesPeer): Promise<FarRoutines | null> => {
    const held = kept.get(peer.id) ?? null;
    const away = (): FarRoutines | null => (held ? { ...held, away: true } : null);
    if (peer.state !== "online") return away();
    try {
      const response = await peer.request("scheduled", "", { method: "GET", headers: {}, timeoutMs: FAR_ROUTINES_WAIT_MS });
      const body = (await response.json().catch(() => null)) as { code?: unknown; launch_on?: unknown } | null;
      let next: Kept;
      if (response.status === 404 && body?.code === "routines_off") next = { machine: peer.id, on: false, launch_on: true, rows: [] };
      else if (response.ok) next = { machine: peer.id, on: true, launch_on: body?.launch_on !== false, rows: farRoutineRows(peer.id, body) };
      // An older door (no such route) lists nothing; any other failure shows the last rows.
      else if (response.status === 404) return null;
      else return away();
      kept.set(peer.id, next);
      return { ...next, away: false };
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
