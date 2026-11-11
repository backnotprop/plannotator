/**
 * Which Inbox windows are open, and whether any of them can show a
 * notification.
 *
 * Browser notifications come from an open Inbox tab: with no tab open, or
 * only tabs the browser does not let notify, nothing reaches the person. The
 * server cannot see a browser's permission, so each window reports it: its
 * event stream carries `window=<id>` (plus the permission and origin it had
 * when it connected), and `POST /api/inbox/window` reports a change. A window
 * counts as open while it holds an event stream; a record outlives its last
 * stream by `WINDOW_GRACE_MS`, so an EventSource reconnect (or a report that
 * lands before the stream) keeps what the page said.
 *
 * Tabs share one event stream (packages/inbox/sharedEvents.ts): one tab, the
 * leader, holds the stream for every Inbox tab of its origin and passes the
 * events on. A follower holds no stream, so it reports `served_by`, the
 * leader's window id, and counts as open while that leader holds its own
 * stream, or held one less than the grace ago (a handover). Only a leader's
 * own stream counts: a tab served by a tab that is itself only served is not
 * counted, so two tabs naming each other never keep each other open. After the
 * whole browser goes, its followers stop counting one grace after the
 * leader's stream closed. A tab that closes reports `gone` (a beacon at pagehide, or the
 * leader, which watches each follower's Web Lock and sees a crashed tab
 * release it): it stops counting at once.
 *
 * Everything is in memory: a restart forgets the windows, and they report
 * again as their streams reconnect.
 */

import type { InboxNotifyReach, InboxWindowPermission } from "@plannotator/core/inbox-types";

/** How long a window's record outlives its last event stream (an EventSource reconnects in ~2 s). */
export const WINDOW_GRACE_MS = 15_000;

const WINDOW_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PERMISSIONS: readonly InboxWindowPermission[] = ["granted", "default", "denied", "unsupported"];

/** A window id the page made (`crypto.randomUUID()` or similar), or null. */
export function parseWindowId(value: unknown): string | null {
  return typeof value === "string" && WINDOW_ID.test(value) ? value : null;
}

/** A permission the page reported, or null. */
export function parseWindowPermission(value: unknown): InboxWindowPermission | null {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value) ? (value as InboxWindowPermission) : null;
}

/** An `http(s)://host[:port]` origin the page reported, or null. */
export function parseWindowOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin === value ? value : null;
  } catch {
    return null;
  }
}

interface WindowRecord {
  streams: number;
  /** When this window's last stream closed (null: it never held one, or holds one now). */
  streamEndedAt: number | null;
  /** The leader whose event stream serves this follower (no stream of its own), or null. */
  servedBy: string | null;
  /** The tab said it closed: not counted, kept for the grace (followers it served still count). */
  gone: boolean;
  permission: InboxWindowPermission;
  origin: string | null;
  via: "local" | "tailnet";
  /** When the window last reported `used` (it had focus); 0 before that. */
  usedAt: number;
  drop: ReturnType<typeof setTimeout> | null;
}

export interface InboxWindows {
  /** An event stream opened for `id`; call the answer when it closes. */
  connect(id: string, report: { permission: InboxWindowPermission | null; origin: string | null; via: "local" | "tailnet" }): () => void;
  /**
   * The page's report: its permission (and origin) changed. `servedBy`: the
   * leader whose stream this follower tab listens to (absent or null for a
   * tab with its own stream). A report also takes back an earlier `gone`.
   */
  report(id: string, report: { permission: InboxWindowPermission; origin: string | null; via: "local" | "tailnet"; servedBy?: string | null; used?: boolean }): void;
  /** The open window on this computer the person used last (`plannotator inbox --open <thread>` moves it), or null. */
  lastUsed(): string | null;
  /** The tab closed (its pagehide beacon, or the leader saw its lock released): it stops counting now. */
  leave(id: string): void;
  /** What Settings shows: open windows and how many can notify. */
  reach(enabled: boolean): InboxNotifyReach;
  /** Called when `reach` may have changed. */
  subscribe(listener: () => void): () => void;
  stop(): void;
}

export function createInboxWindows(options: { graceMs?: number; now?: () => number } = {}): InboxWindows {
  const graceMs = options.graceMs ?? WINDOW_GRACE_MS;
  const now = options.now ?? Date.now;
  const windows = new Map<string, WindowRecord>();
  /** One timer per closed stream: its followers stop counting a grace later, and the pages hear it. */
  const expiries = new Set<ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  let last = "";
  const changed = () => {
    // Tell the pages only when the counts they draw changed.
    const key = JSON.stringify(summary());
    if (key === last) return;
    last = key;
    for (const listener of listeners) listener();
  };
  /** The window holds its own stream, or held one less than the grace ago. Never through another tab. */
  const ownStream = (w: WindowRecord): boolean =>
    w.streams > 0 || (w.streamEndedAt !== null && now() - w.streamEndedAt < graceMs);
  /** A window counts while it holds a stream, or while the leader serving it holds (or just held) its own. */
  const isOpen = (w: WindowRecord): boolean => {
    if (w.gone) return false;
    if (w.streams > 0) return true;
    if (!w.servedBy) return false;
    const leader = windows.get(w.servedBy);
    return leader !== undefined && leader !== w && ownStream(leader);
  };
  const summary = () => {
    const open = [...windows.values()].filter(isOpen);
    const allowed = open.filter((w) => w.permission === "granted");
    return {
      windows: open.length,
      allowed: allowed.length,
      allowed_origins: [...new Set(allowed.map((w) => w.origin).filter((o): o is string => o !== null))].sort(),
    };
  };
  const scheduleDrop = (id: string, record: WindowRecord) => {
    if (record.drop) clearTimeout(record.drop);
    record.drop = setTimeout(() => {
      record.drop = null;
      if (windows.get(id) !== record || record.streams > 0) return;
      // A follower still served by a live leader stays (checked again a grace later).
      if (!record.gone && isOpen(record)) {
        scheduleDrop(id, record);
        return;
      }
      windows.delete(id);
      changed();
    }, graceMs);
    (record.drop as { unref?: () => void }).unref?.();
  };
  const recordOf = (id: string, via: "local" | "tailnet"): WindowRecord => {
    let record = windows.get(id);
    if (!record) {
      record = { streams: 0, streamEndedAt: null, servedBy: null, gone: false, permission: "unknown", origin: null, via, usedAt: 0, drop: null };
      windows.set(id, record);
    }
    return record;
  };

  return {
    connect(id, report) {
      const record = recordOf(id, report.via);
      // A reconnect's URL carries what the page said when it first connected:
      // a report made since (POST) wins over it.
      if (record.permission === "unknown" && report.permission) record.permission = report.permission;
      if (record.origin === null && report.origin) record.origin = report.origin;
      record.via = report.via;
      record.gone = false;
      record.streams += 1;
      record.streamEndedAt = null;
      if (record.drop) {
        clearTimeout(record.drop);
        record.drop = null;
      }
      changed();
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        record.streams = Math.max(0, record.streams - 1);
        if (record.streams === 0) {
          record.streamEndedAt = now();
          scheduleDrop(id, record);
          // The followers it served stop counting when the grace ends: tell the pages then.
          const expiry = setTimeout(() => {
            expiries.delete(expiry);
            changed();
          }, graceMs + 1);
          (expiry as { unref?: () => void }).unref?.();
          expiries.add(expiry);
        }
        changed();
      };
    },
    report(id, report) {
      const record = recordOf(id, report.via);
      record.permission = report.permission;
      if (report.origin) record.origin = report.origin;
      record.via = report.via;
      record.gone = false;
      record.servedBy = report.servedBy && report.servedBy !== id ? report.servedBy : null;
      if (report.used) record.usedAt = now();
      // A report before the stream (or after it closed) is kept for the grace only
      // (a follower's, for as long as its leader is known: see scheduleDrop).
      if (record.streams === 0) scheduleDrop(id, record);
      changed();
    },
    leave(id) {
      const record = windows.get(id);
      if (!record || record.gone) return;
      record.gone = true;
      // Kept for the grace, so followers it served still count until they report their new leader.
      if (record.streams === 0) scheduleDrop(id, record);
      changed();
    },
    reach(enabled) {
      return { enabled, ...summary() };
    },
    lastUsed() {
      // Only this computer's windows: a window opened over the tailnet is another device's, never moved from here.
      // A tie goes to the window that opened later.
      let best: [string, WindowRecord] | null = null;
      for (const entry of windows) {
        if (entry[1].via !== "local" || !isOpen(entry[1])) continue;
        if (!best || entry[1].usedAt >= best[1].usedAt) best = entry;
      }
      return best ? best[0] : null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      for (const record of windows.values()) if (record.drop) clearTimeout(record.drop);
      for (const expiry of expiries) clearTimeout(expiry);
      expiries.clear();
      windows.clear();
      listeners.clear();
    },
  };
}
