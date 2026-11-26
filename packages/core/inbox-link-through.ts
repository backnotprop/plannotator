/**
 * Link two of the person's computers through a third (docs/agent-guides/inbox-machines.md, "Link two computers
 * through a third"). Studio is linked to Laptop and to Mini, which are not linked to each other: Studio's Settings →
 * Machines offers "Laptop and Mini" with Link, and Laptop's offers "Mini · through Studio". One click on either and
 * Studio introduces the two over its own links; they then hold an ordinary direct link, made by the same pairing as
 * a link by hand.
 *
 * This file is the shapes and the detection, shared by the server and the window. Mark `link-through`.
 */

/** The mark a linked computer's list carries when it names its links and its door brokers and takes introductions. */
export const LINK_THROUGH_MARK = "link-through";

/** One computer a linked computer is linked to, as its list names it (to a linked computer's token only). */
export interface LinkThroughWireLink {
  id: string;
  name: string;
  /** That computer's list takes `link-through` too (as the one naming it last read it): only then can it be introduced. */
  through: boolean;
  /** Asleep, offline or out of date, as the one naming it sees it now. */
  away: boolean;
}

/** A link the computer naming it is making between two of its links. */
export interface LinkThroughWireJob {
  /** The computer that takes the other's link code (the one that asked, or the first the person named). */
  a: string;
  /** The computer that makes the link code. */
  c: string;
  state: "waiting" | "linking" | "failed";
  /** Why it did not link (failed), in the words of the computer that refused. */
  why: string | null;
}

/** A list's `link_through`, to a linked computer's token only. */
export interface LinkThroughWire {
  links: LinkThroughWireLink[];
  pending: LinkThroughWireJob[];
}

/** How a row stands. `waiting`: one of the computers it needs is away (`waiting_for` names it). */
export type LinkThroughStatus = "idle" | "linking" | "waiting" | "failed";

/** On the computer linked to both: two of its links that are not linked to each other. */
export interface LinkThroughPairView {
  a: { id: string; name: string };
  c: { id: string; name: string };
  status: LinkThroughStatus;
  waiting_for: string | null;
  why: string | null;
}

/** On one of the two: a computer it reaches only through one of its links. */
export interface LinkThroughRowView {
  id: string;
  name: string;
  via: { id: string; name: string };
  status: LinkThroughStatus;
  waiting_for: string | null;
  why: string | null;
}

/** The self machine's `link_through` in `GET /api/inbox/machines` and the `machines` frame. Absent from an older Inbox. */
export interface LinkThroughView {
  pairs: LinkThroughPairView[];
  through: LinkThroughRowView[];
}

/** What this Inbox knows of one of its links, to detect the gaps. */
export interface LinkThroughPeerFacts {
  id: string;
  name: string;
  state: string;
  /** The marks its list takes (none until its list is read, and from an older Inbox). */
  marks: readonly string[];
  /** Its list's `link_through` (null until read, and from an older Inbox). */
  wire: LinkThroughWire | null;
}

const LINKS_MAX = 64;
const NAME_MAX = 64;
const WHY_MAX = 300;
const IBX = /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/;

/** One line, no control characters, at most `max` characters. */
export function linkThroughText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** A linked computer's `link_through`, read by field: null when it is not one (an older Inbox sends none). */
export function readLinkThroughWire(raw: unknown): LinkThroughWire | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as { links?: unknown; pending?: unknown };
  if (!Array.isArray(value.links)) return null;
  const links: LinkThroughWireLink[] = [];
  for (const item of value.links.slice(0, LINKS_MAX)) {
    if (!item || typeof item !== "object") continue;
    const link = item as Record<string, unknown>;
    if (typeof link.id !== "string" || !IBX.test(link.id) || links.some((l) => l.id === link.id)) continue;
    links.push({ id: link.id, name: linkThroughText(link.name, NAME_MAX) || "Other computer", through: link.through === true, away: link.away === true });
  }
  const pending: LinkThroughWireJob[] = [];
  for (const item of Array.isArray(value.pending) ? value.pending.slice(0, LINKS_MAX) : []) {
    if (!item || typeof item !== "object") continue;
    const job = item as Record<string, unknown>;
    if (typeof job.a !== "string" || typeof job.c !== "string" || !IBX.test(job.a) || !IBX.test(job.c) || job.a === job.c) continue;
    const state = job.state === "linking" || job.state === "failed" ? job.state : "waiting";
    pending.push({ a: job.a, c: job.c, state, why: state === "failed" ? linkThroughText(job.why, WHY_MAX) || null : null });
  }
  return { links, pending };
}

const takes = (peer: LinkThroughPeerFacts) => peer.marks.includes(LINK_THROUGH_MARK) && peer.wire !== null;
const isAway = (state: string) => state !== "online" && state !== "connecting";
const samePair = (job: { a: string; c: string }, x: string, y: string) => (job.a === x && job.c === y) || (job.a === y && job.c === x);

/**
 * On the computer linked to both: every two of its links that take the mark and whose lists name neither as linked
 * to the other, with how its own job for them stands.
 */
export function linkThroughPairs(peers: readonly LinkThroughPeerFacts[], jobs: readonly LinkThroughWireJob[]): LinkThroughPairView[] {
  const able = peers.filter(takes);
  const pairs: LinkThroughPairView[] = [];
  for (let i = 0; i < able.length; i++) {
    for (let j = i + 1; j < able.length; j++) {
      const x = able[i]!;
      const y = able[j]!;
      if (x.wire!.links.some((l) => l.id === y.id) || y.wire!.links.some((l) => l.id === x.id)) continue;
      const job = jobs.find((candidate) => samePair(candidate, x.id, y.id));
      const [a, c] = job && job.a === y.id ? [y, x] : [x, y];
      const away = [a, c].find((peer) => isAway(peer.state)) ?? null;
      const status: LinkThroughStatus = !job ? "idle" : job.state === "failed" ? "failed" : job.state === "linking" ? "linking" : away ? "waiting" : "linking";
      pairs.push({
        a: { id: a.id, name: a.name },
        c: { id: c.id, name: c.name },
        status,
        waiting_for: status === "waiting" ? away!.name : null,
        why: status === "failed" ? job!.why : null,
      });
    }
  }
  return pairs;
}

/** One of this Inbox's asks to a link (`via`) to link it with `with`: still held (`why` null), or refused there, in its words. */
export interface LinkThroughAsk {
  via: string;
  with: string;
  why: string | null;
}

/**
 * On one of the two: every computer a link names that is not this one, not linked here, and takes the mark (as that
 * link last read it), once each (through an online link first). `asked`: this Inbox's newest ask per computer.
 */
export function linkThroughRows(selfId: string, peers: readonly LinkThroughPeerFacts[], asked: readonly LinkThroughAsk[]): LinkThroughRowView[] {
  const linked = new Set(peers.map((peer) => peer.id));
  const ordered = [...peers.filter(takes)].sort((p, q) => Number(isAway(p.state)) - Number(isAway(q.state)));
  const rows: LinkThroughRowView[] = [];
  for (const via of ordered) {
    for (const far of via.wire!.links) {
      if (far.id === selfId || linked.has(far.id) || !far.through || rows.some((row) => row.id === far.id)) continue;
      const ask = asked.find((candidate) => candidate.via === via.id && candidate.with === far.id) ?? null;
      const job = via.wire!.pending.find((candidate) => samePair(candidate, selfId, far.id)) ?? null;
      let status: LinkThroughStatus = "idle";
      let waitingFor: string | null = null;
      let why: string | null = null;
      if (ask && ask.why === null) {
        status = isAway(via.state) ? "waiting" : "linking";
        waitingFor = isAway(via.state) ? via.name : null;
      } else if (job?.state === "failed") {
        status = "failed";
        why = job.why;
      } else if (job) {
        const away = far.away ? far.name : isAway(via.state) ? via.name : null;
        status = job.state === "waiting" && away ? "waiting" : "linking";
        waitingFor = status === "waiting" ? away : null;
      } else if (ask) {
        // The link refused the ask itself: its words, and Link again.
        status = "failed";
        why = ask.why;
      }
      rows.push({ id: far.id, name: far.name, via: { id: via.id, name: via.name }, status, waiting_for: waitingFor, why });
    }
  }
  return rows;
}
