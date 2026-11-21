import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxAgentFaceId } from "@plannotator/core/inbox-types";
import { cleanInboxSessionLabel } from "./inbox-sessions";

export const INBOX_SESSION_LABELS_FILE = "session-labels.json";
export const INBOX_SESSION_LABELS_KEPT = 1000;

interface Entry {
  label?: string;
  title?: string;
  at: number;
}

function readEntries(file: string): Map<string, Entry> {
  const found: [string, Entry][] = [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { sessions?: unknown };
    const sessions = parsed && typeof parsed.sessions === "object" && parsed.sessions && !Array.isArray(parsed.sessions) ? (parsed.sessions as Record<string, unknown>) : {};
    for (const [session, value] of Object.entries(sessions)) {
      if (!isInboxAgentFaceId(session) || !value || typeof value !== "object") continue;
      const item = value as { label?: unknown; title?: unknown; at?: unknown };
      const label = cleanInboxSessionLabel(item.label);
      const title = cleanInboxSessionLabel(item.title);
      if (!label && !title) continue;
      const at = typeof item.at === "number" && Number.isFinite(item.at) ? item.at : 0;
      found.push([session, { ...(label ? { label } : {}), ...(title ? { title } : {}), at }]);
    }
  } catch {}
  found.sort((a, b) => a[1].at - b[1].at);
  return new Map(found);
}

export function createInboxSessionLabels(inboxDirPath: string, now: () => number = Date.now) {
  const file = join(inboxDirPath, INBOX_SESSION_LABELS_FILE);
  const entries = readEntries(file);

  const save = (): void => {
    try {
      mkdirSync(inboxDirPath, { recursive: true, mode: 0o700 });
      const sessions = Object.create(null) as Record<string, Entry>;
      for (const [session, entry] of entries) sessions[session] = entry;
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, sessions })}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch {}
  };

  const project = (field: "label" | "title"): Record<string, string> => {
    const out = Object.create(null) as Record<string, string>;
    for (const [session, entry] of entries) if (entry[field]) out[session] = entry[field]!;
    return out;
  };

  return {
    note(session: string, label: string | null, title: string | null): void {
      if (!isInboxAgentFaceId(session)) return;
      const before = entries.get(session);
      if (!((label !== null && label !== before?.label) || (title !== null && title !== before?.title))) return;
      const nextLabel = label ?? before?.label;
      const nextTitle = title ?? before?.title;
      entries.delete(session);
      entries.set(session, { ...(nextLabel ? { label: nextLabel } : {}), ...(nextTitle ? { title: nextTitle } : {}), at: now() });
      while (entries.size > INBOX_SESSION_LABELS_KEPT) entries.delete(entries.keys().next().value as string);
      save();
    },
    labels: () => project("label"),
    titles: () => project("title"),
  };
}
