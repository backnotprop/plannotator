/**
 * Decision mode across linked computers (mark `decisions`; docs/agent-guides/inbox-machines.md, "Decision mode on a
 * linked computer's thread"). A thread's decisions live on the computer whose agent asked them, as the thread does:
 * `GET /api/inbox/decisions?machines=1` is this Inbox's decisions, then each linked computer's, read through its door
 * (`GET decisions`, a machine's token only), each far one with `machine`. So a linked computer's thread shows "Decide
 * these N" and its dialog, and every answer goes there through the forward and the outbox as the thread's own does.
 *
 * Online, a computer is read now (at most FAR_DECISIONS_WAIT_MS); asleep, slow or failing, the decisions it last gave
 * stand (in memory), so a dialog open on its thread keeps its cards while the picks wait for it. One without the mark
 * (an older Plannotator) is never asked: its threads offer no "Decide these N", and nothing says so.
 *
 * Pure but `read`, which asks each computer's door.
 */

import { isInboxId, type InboxDecision } from "@plannotator/core/inbox-types";

/** The mark a linked computer's list carries when its door answers `GET decisions` and its reasons' comment drafts. */
export const DECISIONS_MARK = "decisions";

/** How long the merged read waits for one computer; past it, what that computer last gave. */
export const FAR_DECISIONS_WAIT_MS = 2_000;

/** A decision as the merged read gives it: a far one names its computer (`machine`). */
type MergedDecision = InboxDecision;

/** The part of a linked computer's line the merged read goes through. */
export interface DecisionsPeer {
  id: string;
  state: string;
  list: { marks: readonly string[] } | null;
  request(route: string, search: string, init: { method: "GET"; headers: Record<string, string>; timeoutMs?: number }): Promise<Response>;
}

const DECISION_ID = /^msg_[0-9A-HJKMNP-TV-Z]{26}\/[^/\s]{1,200}$/;

/** A far door's `decisions`, picked by shape: each that reads as a decision, with its computer. */
export function farDecisionsOf(machine: string, body: unknown): MergedDecision[] {
  const list = body && typeof body === "object" ? (body as { decisions?: unknown }).decisions : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const d = entry as Partial<InboxDecision> | null;
    const ok =
      !!d &&
      typeof d === "object" &&
      typeof d.id === "string" &&
      DECISION_ID.test(d.id) &&
      !!d.question &&
      typeof d.question === "object" &&
      !!d.message &&
      isInboxId("msg", d.message.id) &&
      !!d.thread &&
      isInboxId("msg", d.thread.id) &&
      !!d.thread.project &&
      typeof d.thread.project.id === "string" &&
      !!d.session &&
      typeof d.session.key === "string" &&
      !!d.pictures &&
      Array.isArray(d.pictures.inline) &&
      Array.isArray(d.pictures.attachments);
    return ok ? [{ ...(d as InboxDecision), machine }] : [];
  });
}

/**
 * This Inbox's decisions, then each linked computer's in link order. A far decision of a thread this store holds is
 * passed over, an id already listed is listed once, and with a project filter only that project's are kept.
 */
export function mergeDecisions(own: readonly InboxDecision[], far: readonly (readonly MergedDecision[])[], holds: (threadId: string) => boolean, project: string | null): MergedDecision[] {
  const out: MergedDecision[] = [...own];
  const seen = new Set(own.map((d) => d.id));
  for (const decisions of far) {
    for (const d of decisions) {
      if (seen.has(d.id) || holds(d.thread.id) || (project !== null && d.thread.project.id !== project)) continue;
      seen.add(d.id);
      out.push(d);
    }
  }
  return out;
}

/** Each linked computer's decisions, read now while it answers, else the last it gave. */
export function createFarDecisions(peers: () => Iterable<DecisionsPeer>) {
  const kept = new Map<string, MergedDecision[]>();
  const readOne = async (peer: DecisionsPeer): Promise<MergedDecision[]> => {
    const held = kept.get(peer.id) ?? [];
    if (peer.state !== "online") return held;
    try {
      const response = await peer.request("decisions", "", { method: "GET", headers: {}, timeoutMs: FAR_DECISIONS_WAIT_MS });
      // Decision mode off there (the route is gone, as here when it is off): none of its threads offers it.
      if (response.status === 404) {
        kept.delete(peer.id);
        return [];
      }
      if (!response.ok) return held;
      const decisions = farDecisionsOf(peer.id, await response.json());
      kept.set(peer.id, decisions);
      return decisions;
    } catch {
      return held;
    }
  };
  return {
    /** Every linked computer that takes the mark, in link order; an older one is never asked. */
    async read(): Promise<MergedDecision[][]> {
      const asked = [...peers()].filter((peer) => peer.list?.marks.includes(DECISIONS_MARK));
      const known = new Set(asked.map((peer) => peer.id));
      for (const id of kept.keys()) if (!known.has(id)) kept.delete(id);
      return Promise.all(asked.map(readOne));
    },
  };
}
