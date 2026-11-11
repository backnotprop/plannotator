/**
 * Plannotator Inbox: who reads a session's name (the person's rename, `session_labels`, and the generated title or
 * Claude Code's own name, `session_titles`). The owner's ask of 2026-11-11 ("Why are we limiting"): anyone who can
 * already see a thread or session row sees the same name the owner sees for it, and nobody learns of a session they
 * could not otherwise see.
 *
 * - A linked machine's list carries its names (its door answers it as the owner's): this one keeps them
 *   (`inboxPeerSessionNames`) and the merged view shows them on that machine's rows.
 * - A tailnet guest reads the names of the sessions its own answer already carries, rows and Agents alike
 *   (`inboxNamesShown`), and no other: Claude Code's own listing names every session on this computer, the ones
 *   that never reached the Inbox too.
 */

import type { InboxAgentsGroup, InboxListRow } from "@plannotator/core/inbox-types";
import { cleanInboxSessionLabel } from "./inbox-sessions";

/** The most names kept per linked machine (as inbox-claude-names.ts keeps per Inbox). */
const PEER_NAMES_MAX = 500;

/** A linked machine's `session_labels` or `session_titles` as its list sent them: own keys, each name cleaned as a poll's label is. */
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

/** Every session a list answer names: its rows' authors, addressees and participants, and its Agents (with the ids they continue). */
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

/** The names of the sessions in `shown` only. */
export function inboxNamesShown(names: Record<string, string>, shown: ReadonlySet<string>): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const session of Object.keys(names)) if (shown.has(session)) out[session] = names[session]!;
  return out;
}
