/**
 * Merged ships across linked machines (docs/agent-guides/inbox-ship.md, How a ship ends). A ship lives on the machine
 * of its agent's thread, so a PR an agent on a linked machine shipped merges there: this machine's Reviews keeps its
 * own row for that PR while "Merged <time>" shows (core `inboxReviewRows` `shipMerged`) from that machine's ships,
 * read through its door (`GET ships`, machine only, mark `ships`) and kept in memory as last read. Only the merged
 * ones are kept, and only what a landing needs. Never a timer, never waited for: a read starts when this machine's
 * Reviews is read. A machine without the mark (an older one) is never asked.
 */

import { inboxPullRefOfKey } from "@plannotator/core/inbox-types";
import type { InboxShip } from "@plannotator/core/inbox-pull-handoff";
import { readCapped, type PeerLink } from "./inbox-peer-link";

const FAR_SHIPS_MAX_BYTES = 2 * 1024 * 1024;
const FAR_SHIPS_READ_MS = 15_000;
const FAR_SHIPS_MAX = 500;
/** A machine read this recently is not read again: Reviews reads come often, a merge's words last 6 hours. */
const FAR_SHIPS_FRESH_MS = 30_000;

/** What a far ship keeps: what `shipsMergedShown` and the active keys read. */
export type FarMergedShip = Pick<InboxShip, "key" | "url" | "number" | "title" | "state" | "ended_at" | "merged_at">;

type Json = Record<string, unknown>;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const time = (value: unknown): string | null => (text(value, 64) && !Number.isNaN(Date.parse(value)) ? value : null);

/**
 * One far merged or still active (shipping, stuck) ship, read by its shape: a machine's answer is another program's
 * words. Its key is a pull request's, its link that PR's on its own host (https), its number the key's; a merged one
 * has its ended time. Anything else, or a stopped ship: null.
 */
export function farMergedShip(value: unknown): FarMergedShip | null {
  const ship = value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
  const state = ship?.state;
  if (!ship || (state !== "merged" && state !== "shipping" && state !== "stuck") || !text(ship.key, 400) || !text(ship.url, 2000) || typeof ship.title !== "string" || ship.title.length > 2000) return null;
  const ref = inboxPullRefOfKey(ship.key);
  const url = URL.canParse(ship.url) ? new URL(ship.url) : null;
  if (!ref || ship.number !== ref.number || url?.protocol !== "https:" || url.host.toLowerCase() !== ref.host) return null;
  const ended = time(ship.ended_at);
  if (state === "merged" && !ended) return null;
  return { key: ship.key, url: url.href, number: ref.number, title: ship.title, state, ended_at: state === "merged" ? ended : null, merged_at: time(ship.merged_at) };
}

/**
 * A far merged ship's ended time as this computer counts it: the later of its own clock's and when this computer first
 * saw it merged, never later than that first sight. Another computer's clock a day ahead (or a 2099) never keeps the
 * row past 6 hours from here, and one a day behind never drops it at once; that is the first sight.
 */
export function farEndedAt(ended: string, firstSeen: number): string {
  const far = Date.parse(ended);
  return new Date(Math.min(Math.max(far, firstSeen), firstSeen)).toISOString();
}

/** The linked machines' merged and active ships, as last read; a merge's ended time from this computer's first sight. */
export function createMachineShips(options: { peers: () => Iterable<PeerLink>; now?: () => number }) {
  const now = options.now ?? Date.now;
  const lists = new Map<string, FarMergedShip[]>();
  const reading = new Map<string, { done: Promise<void>; abort: AbortController }>();
  const readAt = new Map<string, number>();
  const firstSeen = new Map<string, Map<string, number>>();

  const read = (peer: PeerLink): Promise<void> => {
    const running = reading.get(peer.id);
    if (running) return running.done;
    readAt.set(peer.id, now());
    const abort = new AbortController();
    const run = (async () => {
      try {
        const response = await peer.request("ships", "", { method: "GET", headers: {}, timeoutMs: FAR_SHIPS_READ_MS, signal: abort.signal });
        if (!response.ok) {
          response.body?.cancel().catch(() => {});
          // Code review off there: none of its ships counts here.
          if (response.status === 409 && !abort.signal.aborted) lists.delete(peer.id);
          return;
        }
        const body = await readCapped(response, FAR_SHIPS_MAX_BYTES);
        const answer = body === null ? null : (JSON.parse(body) as { ships?: unknown });
        if (abort.signal.aborted || !answer || !Array.isArray(answer.ships)) return;
        const ships = answer.ships.slice(0, FAR_SHIPS_MAX).flatMap((value) => farMergedShip(value) ?? []);
        // First sight of each merge, by this computer's clock: kept while that machine still lists it merged.
        const seenBefore = firstSeen.get(peer.id) ?? new Map<string, number>();
        const seenNow = new Map<string, number>();
        for (const ship of ships) if (ship.state === "merged") seenNow.set(ship.key, seenBefore.get(ship.key) ?? now());
        firstSeen.set(peer.id, seenNow);
        lists.set(peer.id, ships.map((ship) => (ship.state === "merged" ? { ...ship, ended_at: farEndedAt(ship.ended_at!, seenNow.get(ship.key)!) } : ship)));
      } catch {
        // Asleep or unreachable: its ships stay as last read.
      }
    })().finally(() => {
      if (reading.get(peer.id)?.abort === abort) reading.delete(peer.id);
    });
    reading.set(peer.id, { done: run, abort });
    return run;
  };

  return {
    /** A read of each taker starts now (or joins the one under way), never waited for: the answer is what each had. */
    start(): FarMergedShip[] {
      const peers = [...options.peers()].filter((peer) => peer.list?.marks.includes("ships"));
      for (const peer of peers) if (peer.state === "online" && now() - (readAt.get(peer.id) ?? -Infinity) >= FAR_SHIPS_FRESH_MS) void read(peer);
      return peers.flatMap((peer) => lists.get(peer.id) ?? []);
    },
    async settled(): Promise<void> {
      await Promise.all([...reading.values()].map(({ done }) => done));
    },
    forget(machine: string): void {
      reading.get(machine)?.abort.abort();
      reading.delete(machine);
      lists.delete(machine);
      readAt.delete(machine);
      firstSeen.delete(machine);
    },
  };
}
