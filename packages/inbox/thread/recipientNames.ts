/**
 * How "Who gets this reply" names each agent, on a computer's list and a phone's sheet alike: its session's title
 * (`useRecipientLabels`: the sidebar's name ladder) with "<agent> · <folder>" under it; an untitled session by its fallback name
 * (replyRecipients.ts) with the folder under it. An agent that is not live says its state where the folder goes.
 *
 * Two rows titled alike, or a title that reads as another row's name ("Pi"), carry the fallback name after it, as the
 * `@` list does ("Review (Claude Code 2)"): two sessions of one agent stay told apart.
 */
import { useMemo } from 'react';
import type { InboxAgentsGroup } from '@plannotator/core/inbox-types';
import { useInboxAgentsWho } from '../agentsList';
import type { RecipientRow } from '../replyRecipients';
import { labelOf, type SessionLabels } from '../sessionLabels';
import { agentName } from '../tags';

/**
 * The titles the rows read: the session labels (a name the person gave, else the agent's own, else its host's title:
 * sessionLabels.ts), and for a session with none the name of the thread its agent got first, as the sidebar names it
 * (agents/model.ts `agentRowName`), so a row and the pill read as the agent's sidebar row does.
 */
export function withFirstThreads(labels: SessionLabels, groups: readonly InboxAgentsGroup[] | null): SessionLabels {
  const out: Record<string, string> = Object.create(null);
  for (const agent of (groups ?? []).flatMap((group) => group.agents)) {
    const name = agent.first_thread?.name.trim();
    if (!name) continue;
    for (const session of [agent.session, ...(agent.continues ?? [])]) if (!labelOf(labels, session) && !Object.hasOwn(out, session)) out[session] = name;
  }
  return Object.keys(out).length === 0 ? labels : Object.freeze(Object.assign(Object.create(null), labels, out));
}

/** `withFirstThreads` over the agents as the list has them, redrawn only when who they are changes. */
export function useRecipientLabels(labels: SessionLabels): SessionLabels {
  const groups = useInboxAgentsWho(true);
  return useMemo(() => withFirstThreads(labels, groups), [labels, groups]);
}

export const RECIPIENT_QUIET: Record<RecipientRow['state'], string | null> = { live: null, ended: 'ended', reader: 'Not woken', old: 'Update' };

export interface RecipientName {
  /** The row's name: its title (with the fallback name after it when another row reads the same), else the fallback. */
  name: string;
  /** Its session's whole title, or null for an untitled session. */
  title: string | null;
  /** The agent's name before the folder, for a titled row only (an untitled row's name already says it). */
  agent: string | null;
  /** Its state's word ("ended"), or null while it is live. */
  quiet: string | null;
  /** The line under the name: "Claude Code · ledger", "Claude Code · ended", "ledger". */
  detail: string;
}

export function recipientNames(rows: readonly RecipientRow[], labels: SessionLabels, folderOf: (session: string) => string): Map<string, RecipientName> {
  const titles = new Map(rows.map((row) => [row.session, labelOf(labels, row.session)]));
  const plain = new Set(rows.filter((row) => !titles.get(row.session)).map((row) => row.label));
  const out = new Map<string, RecipientName>();
  for (const row of rows) {
    const title = titles.get(row.session) ?? null;
    const shared = title !== null && (plain.has(title) || rows.some((o) => o !== row && titles.get(o.session) === title));
    const agent = title === null ? null : agentName(row.host);
    const quiet = RECIPIENT_QUIET[row.state];
    out.set(row.session, {
      name: title === null ? row.label : shared ? `${title} (${row.label})` : title,
      title,
      agent,
      quiet,
      detail: [agent, quiet ?? folderOf(row.session)].filter(Boolean).join(' · '),
    });
  }
  return out;
}
