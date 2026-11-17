/**
 * Plannotator Inbox: each session's last known label and host title, kept across Inbox restarts (issue #3462).
 *
 *   inbox/session-labels.json   { v: 1, sessions: { [session id]: { label?, title?, at } } }, 0600, written whole
 *                               (temp, then rename), as agent-faces.json is
 *
 * Display only, like the polled label itself: nothing routes on it. A live session's own label always wins; this is
 * only what an ended session (or one the restarted Inbox has not heard yet) shows. Written when a label or title
 * changes, never on an unchanged poll, and a poll without a label keeps the last one. The newest
 * INBOX_SESSION_LABELS_KEPT sessions are kept, so an ended session stays findable for resume.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxAgentFaceId } from "@plannotator/core/inbox-types";
import { cleanInboxSessionLabel } from "./inbox-sessions";

export const INBOX_SESSION_LABELS_FILE = "session-labels.json";
export const INBOX_SESSION_LABELS_KEPT = 1000;

interface Entry {
  label?: string;
  title?: string;
  /** When the label or title last changed (ms). Orders the cap. */
  at: number;
}

type State = "missing" | "ok" | "bad" | "newer";

function readFile(inboxDirPath: string): { entries: Map<string, Entry>; state: State } {
  const none = (state: State) => ({ entries: new Map<string, Entry>(), state });
  let raw: string;
  try {
    raw = readFileSync(join(inboxDirPath, INBOX_SESSION_LABELS_FILE), "utf8");
  } catch (e) {
    return none((e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "bad");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return none("bad");
  }
  const file = value as { v?: unknown; sessions?: unknown } | null;
  if (!file || typeof file !== "object" || Array.isArray(file)) return none("bad");
  if (typeof file.v === "number" && file.v > 1) return none("newer");
  if (file.v !== 1) return none("bad");
  const found: [string, Entry][] = [];
  if (file.sessions && typeof file.sessions === "object" && !Array.isArray(file.sessions)) {
    for (const [session, raw] of Object.entries(file.sessions as Record<string, unknown>)) {
      if (!isInboxAgentFaceId(session) || !raw || typeof raw !== "object") continue;
      const item = raw as { label?: unknown; title?: unknown; at?: unknown };
      const label = cleanInboxSessionLabel(item.label);
      const title = cleanInboxSessionLabel(item.title);
      if (!label && !title) continue;
      const at = typeof item.at === "number" && Number.isFinite(item.at) ? item.at : 0;
      found.push([session, { ...(label ? { label } : {}), ...(title ? { title } : {}), at }]);
    }
  }
  // Oldest first, so the Map's order is the order of change (a numeric-looking session id would reorder a plain object).
  found.sort((a, b) => a[1].at - b[1].at);
  return { entries: new Map(found), state: "ok" };
}

export function createInboxSessionLabels(inboxDirPath: string, now: () => number = Date.now) {
  const loaded = readFile(inboxDirPath);
  const entries = loaded.entries;
  let state = loaded.state;

  const save = (): void => {
    // A file from a newer Plannotator is read as none and never written over.
    if (state === "newer") return;
    const file = join(inboxDirPath, INBOX_SESSION_LABELS_FILE);
    mkdirSync(inboxDirPath, { recursive: true });
    if (state === "bad") renameSync(file, `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    const sessions = Object.create(null) as Record<string, Entry>;
    for (const [session, entry] of entries) sessions[session] = entry;
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, sessions })}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    state = "ok";
  };

  const project = (field: "label" | "title"): Record<string, string> => {
    const out = Object.create(null) as Record<string, string>;
    for (const [session, entry] of entries) if (entry[field]) out[session] = entry[field]!;
    return out;
  };

  return {
    /**
     * What a poll sent (cleaned, or null for none). Written only when it differs from what is kept; a null keeps the
     * last known value. A failed write (full disk, read-only folder) never reaches the poll.
     */
    note(session: string, label: string | null, title: string | null): void {
      if (!isInboxAgentFaceId(session)) return;
      const before = entries.get(session);
      if (!((label !== null && label !== before?.label) || (title !== null && title !== before?.title))) return;
      const nextLabel = label ?? before?.label;
      const nextTitle = title ?? before?.title;
      entries.delete(session);
      entries.set(session, { ...(nextLabel ? { label: nextLabel } : {}), ...(nextTitle ? { title: nextTitle } : {}), at: now() });
      while (entries.size > INBOX_SESSION_LABELS_KEPT) entries.delete(entries.keys().next().value as string);
      try {
        save();
      } catch {
        // Kept in memory for this run; the next change tries again.
      }
    },
    /** Every kept label by session id (no prototype). */
    labels: () => project("label"),
    /** Every kept host title by session id (no prototype). */
    titles: () => project("title"),
  };
}

export type InboxSessionLabels = ReturnType<typeof createInboxSessionLabels>;