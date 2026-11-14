/** Who reads a session's name: whoever already sees the session; a guest learns of no session it is not shown. */
import type { InboxAgentsGroup, InboxListRow } from "@plannotator/core/inbox-types";
import { cleanInboxSessionLabel } from "./inbox-sessions";

const PEER_NAMES_MAX = 500;

/** A peer's names are cleaned as a poll's label is: they reach this window as display text. */
export function inboxPeerSessionNames(value: unknown): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let kept = 0;
  for (const [session, name] of Object.entries(value as Record<string, unknown>)) {
    const clean = cleanInboxSessionLabel(name);
    if (!session || !clean) continue;
    out[session] = clean;
    if ((kept += 1) >= PEER_NAMES_MAX) break;
  }
  return out;
}

interface ListShape {
  sections?: { threads: InboxListRow[] }[];
  snoozed?: InboxListRow[];
  pins?: InboxListRow[];
  agents?: InboxAgentsGroup[];
}

export function inboxSessionsShown(model: ListShape): Set<string> {
  const shown = new Set<string>();
  const row = (r: InboxListRow) => {
    if (r.author.kind === "agent" && r.author.session) shown.add(r.author.session);
    if (r.addressee?.session) shown.add(r.addressee.session);
    for (const p of r.participants ?? []) shown.add(p.session);
  };
  for (const section of model.sections ?? []) section.threads.forEach(row);
  (model.snoozed ?? []).forEach(row);
  (model.pins ?? []).forEach(row);
  for (const group of model.agents ?? []) {
    for (const agent of group.agents) {
      shown.add(agent.session);
      for (const id of agent.continues ?? []) shown.add(id);
    }
  }
  return shown;
}

export function inboxNamesShown(names: Record<string, string>, shown: ReadonlySet<string>): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const session of Object.keys(names)) if (shown.has(session)) out[session] = names[session]!;
  return out;
}
