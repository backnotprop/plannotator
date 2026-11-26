/**
 * Pinned artifacts and the Artifacts wall across linked machines (mark `artifact-pins`, approval
 * "inbox-artifact-stars"; docs/agent-guides/inbox-machines.md). A pin lives on its thread's own machine, as a star
 * does: the window pins a linked machine's artifact through the forward and the outbox (`POST artifact-pins`, a
 * `set`), that machine's list carries its pins back (`artifact_pins`, to a machine's token only), and its stream
 * says `event: artifact-pins` to a machine that asks, so this Inbox reads that list again and tells its windows.
 *
 * - `GET /api/inbox/artifact-pins?machines=1`: this Inbox's pins, then each linked machine's as its list last said
 *   (an asleep machine's too, from memory), each with `machine`.
 * - `GET /api/inbox/artifacts?machines=1`: the Wall over this Inbox's artifacts and each linked machine's (its door's
 *   `GET artifacts`, read when a window asks), newest first. The cursor holds each machine's own offset, so a page goes
 *   on exactly where the last one ended, however deep. An asleep machine answers with the page it last gave for the
 *   same ask (`away`); one never read, or an older one (no mark, or a door 404), adds nothing.
 *
 * Pure but `readFarWall`, which asks one machine's door.
 */

import { INBOX_ARTIFACT_TYPES, type InboxArtifactPin, type InboxArtifactRow, type InboxArtifactsPage, type InboxArtifactType } from "@plannotator/core/inbox-artifact-pins";
import { isInboxId } from "@plannotator/core/inbox-types";

/** The mark a machine's list carries when its artifacts are pinned and listed from a linked machine. */
export const ARTIFACT_PINS_MARK = "artifact-pins";

/** How long the Wall waits for a linked machine's page; past it, the page it last gave (as the Archived group). */
export const FAR_WALL_WAIT_MS = 2_000;
/** Pages kept per machine for when it sleeps: one per ask (filters and offset). */
const FAR_WALL_KEPT = 8;

// An attachment id, `guide:<message id>`, or an html block's `html:<message id>:<hash>`.
const ARTIFACT_KEY = /^(?:(?:guide:)?[A-Za-z0-9_-]{1,120}|html:[A-Za-z0-9_-]{1,120}:[a-f0-9]{16})$/;
const MACHINE_ID = /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The pins as the routes send them: key, thread and time only. */
export function artifactPinsWire(pins: readonly InboxArtifactPin[]): InboxArtifactPin[] {
  return pins.map((pin) => ({ key: pin.key, thread_id: pin.thread_id, pinned_at: pin.pinned_at }));
}

/** A linked machine's list's `artifact_pins`, picked by name (none from an Inbox before them). */
export function readFarArtifactPins(value: unknown): InboxArtifactPin[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((pin: Record<string, unknown> | null) =>
    pin && typeof pin.key === "string" && ARTIFACT_KEY.test(pin.key) && isInboxId("msg", pin.thread_id) && typeof pin.pinned_at === "string" ? [{ key: pin.key, thread_id: pin.thread_id, pinned_at: pin.pinned_at }] : [],
  );
}

/**
 * This Inbox's pins, then each linked machine's in its own order, each with its machine. A far pin of a thread this
 * store holds is never taken, and a key already listed is listed once.
 */
export function mergeArtifactPins(own: readonly InboxArtifactPin[], far: readonly { machine: string; pins: readonly InboxArtifactPin[] }[], holds: (threadId: string) => boolean): InboxArtifactPin[] {
  const out = artifactPinsWire(own);
  const seen = new Set(out.map((pin) => pin.key));
  for (const { machine, pins } of far) {
    for (const pin of pins) {
      if (seen.has(pin.key) || holds(pin.thread_id)) continue;
      seen.add(pin.key);
      out.push({ ...pin, machine });
    }
  }
  return out;
}

/** The merged Wall's cursor: this Inbox's offset, then `<machine>:<offset>` for each machine read past its start. */
export function wallCursorText(own: number, far: ReadonlyMap<string, number>): string {
  return [String(own), ...[...far].filter(([, n]) => n > 0).map(([machine, n]) => `${machine}:${n}`)].join(",");
}

/** The merged Wall's cursor read back; null for one that does not read as one (a `422`). */
export function readWallCursor(raw: string | null): { own: number; far: Map<string, number> } | null {
  if (raw === null || raw === "") return { own: 0, far: new Map() };
  const [head, ...rest] = raw.split(",");
  const whole = (text: string | undefined) => (text !== undefined && /^[0-9]{1,15}$/.test(text) ? Number(text) : null);
  const own = whole(head);
  if (own === null) return null;
  const far = new Map<string, number>();
  for (const part of rest) {
    const [machine, n] = part.split(":");
    const offset = whole(n);
    if (!machine || !MACHINE_ID.test(machine) || offset === null || far.has(machine)) return null;
    far.set(machine, offset);
  }
  return { own, far };
}

/** One linked machine's Wall page for this ask: null when it has none (never read, or an older door), and whether it is the last-known one. */
export interface FarWall {
  machine: string;
  page: InboxArtifactsPage | null;
  away: boolean;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

/** A far door's Wall page, picked by name: its rows with their machine. */
export function farWallPage(machine: string, body: unknown): InboxArtifactsPage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const artifacts = (Array.isArray(b.artifacts) ? b.artifacts : [])
    .filter((row): row is InboxArtifactRow => {
      const r = row as Partial<InboxArtifactRow> | null;
      return !!r && typeof r === "object" && typeof r.key === "string" && ARTIFACT_KEY.test(r.key) && isInboxId("msg", r.thread_id) && typeof r.message_id === "string" && typeof r.at === "string";
    })
    .map((row) => ({ ...row, machine }));
  const counts = (b.counts && typeof b.counts === "object" ? b.counts : {}) as Record<string, unknown>;
  const typesIn = (counts.types && typeof counts.types === "object" ? counts.types : {}) as Record<string, unknown>;
  const types = Object.fromEntries(INBOX_ARTIFACT_TYPES.map((t) => [t, count(typesIn[t])])) as Record<InboxArtifactType, number>;
  return {
    artifacts,
    next_cursor: typeof b.next_cursor === "string" ? b.next_cursor : null,
    total: Math.max(count(b.total), artifacts.length),
    counts: { all: count(counts.all), pinned: count(counts.pinned), types },
  };
}

/**
 * This Inbox's page and each linked machine's, as one: each was asked for `limit` rows from its own offset, so taking
 * the newest `limit` of them all is exact, and the next cursor moves each machine by what it gave. A tie keeps this
 * Inbox first, then the machines in order. A far row of a thread this store holds is passed over (its offset still
 * moves). Totals and counts add up.
 */
export function mergeWall(
  own: InboxArtifactsPage,
  far: readonly FarWall[],
  cursor: { own: number; far: ReadonlyMap<string, number> },
  limit: number,
  holds: (threadId: string) => boolean,
): InboxArtifactsPage & { machines: Record<string, { away: boolean }> } {
  const sources = [
    { machine: null as string | null, rows: own.artifacts, more: own.next_cursor !== null, at: 0 },
    ...far.flatMap(({ machine, page }) => (page ? [{ machine, rows: page.artifacts, more: page.next_cursor !== null, at: 0 }] : [])),
  ];
  const artifacts: InboxArtifactRow[] = [];
  while (artifacts.length < limit) {
    let next: (typeof sources)[number] | null = null;
    for (const source of sources) {
      const row = source.rows[source.at];
      if (row && (!next || row.at > next.rows[next.at]!.at)) next = source;
    }
    if (!next) break;
    const row = next.rows[next.at]!;
    next.at += 1;
    if (next.machine === null || !holds(row.thread_id)) artifacts.push(row);
  }
  const more = sources.some((source) => source.at < source.rows.length || source.more);
  const offsets = new Map(cursor.far);
  for (const source of sources) if (source.machine) offsets.set(source.machine, (cursor.far.get(source.machine) ?? 0) + source.at);
  const types = { ...own.counts.types };
  let total = own.total;
  let all = own.counts.all;
  let pinned = own.counts.pinned;
  const machines: Record<string, { away: boolean }> = {};
  for (const { machine, page, away } of far) {
    machines[machine] = { away };
    if (!page) continue;
    total += page.total;
    all += page.counts.all;
    pinned += page.counts.pinned;
    for (const t of INBOX_ARTIFACT_TYPES) types[t] += page.counts.types[t];
  }
  return { artifacts, next_cursor: more ? wallCursorText(cursor.own + sources[0]!.at, offsets) : null, total, counts: { all, pinned, types }, machines };
}

/** The door's search for one machine's part of a merged ask: the same filters, its own offset, `limit` rows. */
export function farWallSearch(url: URL, offset: number, limit: number): string {
  const search = new URLSearchParams();
  for (const name of ["pinned", "type", "archived"]) {
    const value = url.searchParams.get(name);
    if (value !== null) search.set(name, value);
  }
  if (offset > 0) search.set("cursor", String(offset));
  search.set("limit", String(limit));
  return `?${search}`;
}

/** The part of a linked machine's line the Wall reads through. */
export interface WallPeer {
  readonly id: string;
  readonly state: string;
  request(route: string, search: string, init: { method: "GET"; headers: Record<string, string>; timeoutMs?: number }): Promise<Response>;
}

const kept = new WeakMap<WallPeer, Map<string, InboxArtifactsPage>>();

/**
 * One machine's Wall page for one ask. Online, read now (at most FAR_WALL_WAIT_MS); asleep, slow or failing, the page
 * it last gave for the same ask, marked `away`. A door that predates the route (404) shows nothing.
 */
export async function readFarWall(peer: WallPeer, search: string): Promise<FarWall> {
  let pages = kept.get(peer);
  if (!pages) kept.set(peer, (pages = new Map()));
  const held = pages.get(search) ?? null;
  if (peer.state !== "online") return { machine: peer.id, page: held, away: true };
  try {
    const response = await peer.request("artifacts", search, { method: "GET", headers: {}, timeoutMs: FAR_WALL_WAIT_MS });
    if (response.status === 404) return { machine: peer.id, page: null, away: false };
    if (!response.ok) return { machine: peer.id, page: held, away: true };
    const page = farWallPage(peer.id, await response.json());
    if (!page) return { machine: peer.id, page: held, away: true };
    pages.delete(search);
    pages.set(search, page);
    for (const old of pages.keys()) if (pages.size > FAR_WALL_KEPT) pages.delete(old);
    return { machine: peer.id, page, away: false };
  } catch {
    return { machine: peer.id, page: held, away: true };
  }
}
