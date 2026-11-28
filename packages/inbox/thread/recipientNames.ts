/**
 * How "Who gets this reply" names each agent, on a computer's list and a phone's sheet alike, by the `thread` context
 * of the one name ladder (agents/model.ts `agentRowName`): its session's own name (sessionLabels.ts: a name the person
 * gave, else the name given in the agent, else its host's title) with "<agent> · <folder>" under it; else its agent's
 * name (the fallback name, numbered: replyRecipients.ts) with the folder under it. Never the name of the thread it got
 * first: inside a thread that would only repeat the title the person is reading. An agent that is not live says its
 * state where the folder goes.
 *
 * Two rows titled alike, or a title that reads as another row's name ("Pi"), carry the fallback name after it, as the
 * `@` list does ("Review (Claude Code 2)"): two sessions of one agent stay told apart. The fallback is the row's
 * `fallback` (named as if no session were renamed), so two sessions renamed alike never read "Reviewer (Reviewer)".
 */
import type { RecipientRow } from '../replyRecipients';
import { labelOf, type SessionLabels } from '../sessionLabels';
import { agentName } from '../tags';

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
      // Two alike: each says its fallback name (as if none were renamed), never its own label, which may be the title itself.
      name: title === null ? row.label : shared ? `${title} (${row.fallback ?? row.label})` : title,
      title,
      agent,
      quiet,
      detail: [agent, quiet ?? folderOf(row.session)].filter(Boolean).join(' · '),
    });
  }
  return out;
}
