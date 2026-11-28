/**
 * The window's search rows read a skill emoji's reply as the thread draws it: a reply whose words are "🦃 /bro"
 * (core inbox-skill-reaction.ts; the owner's pick, 2026-11-26: "As a normal reply with text"). Only the window's route
 * (inbox-search.ts) reads it this way: the agents' search (inbox-mcp-search.ts, inbox-far-find.ts) reads the index's
 * own words, the body the agent was sent, unchanged.
 */
import { skillReactionText } from "@plannotator/core/inbox-folding";
import { inboxSearchRanges, inboxSearchSnippet, type InboxSearchRow } from "@plannotator/core/inbox-search";
import type { InboxSearchAnswer } from "@plannotator/shared/inbox/search";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export function searchShownToPerson<A extends InboxSearchAnswer>(answer: A, store: Pick<InboxStore, "message">): A {
  const rows = answer.groups?.messages;
  if (!rows) return answer;
  let changed = false;
  const shown = rows.map((row): InboxSearchRow => {
    if (row.type !== "message" || row.author.kind !== "me") return row;
    const message = store.message(row.id);
    const text = message ? skillReactionText(message) : null;
    if (text === null) return row;
    changed = true;
    return { ...row, snippet: inboxSearchSnippet(text, inboxSearchRanges(text, answer.terms)) };
  });
  return changed ? { ...answer, groups: { ...answer.groups, messages: shown } } : answer;
}
