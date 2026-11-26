/**
 * Filter by typing: the rule that narrows the list to the threads whose title holds what the person types
 * (components/TitleFilter.tsx draws the field; the filter menu's first row opens it, components/ListFilter.tsx).
 *
 * - A thread matches when every word typed is in its title: the name the list shows (`thread_name`) or its subject,
 *   so a thread renamed in the list is still found by the subject its agent gave it. Words can come in any order.
 * - Case and accents are ignored, as the menu's find fields ignore them (listFilterSearch.ts `fold`). Spaces
 *   only separate words: "  page   layout " is "page layout".
 * - It narrows rows, never groups: a group keeps its matches and its count follows; a group left with none goes.
 * - It applies on top of the menu's picks (agent, project, date…), never in place of them, and to every row the list
 *   holds, a linked computer's too.
 * - No word typed: the list as it was, the same sections (no new arrays, so nothing downstream draws again).
 *
 * No React here: the e2e spec reads the row's label from this file.
 */
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { fold } from './listFilterSearch';

/**
 * The menu row that opens the field: "Title…", as on the approved page (approval "inbox-filter-by-typing"), unless the
 * owner picks another of "Type…", "Input…", "Find…". The one place it is written.
 */
export const TITLE_FILTER_LABEL = 'Title…';
/** The field's placeholder and accessible name. */
export const TITLE_FILTER_PLACEHOLDER = 'Filter by title';
/** Where the list would be when nothing matches. */
export const TITLE_FILTER_NONE = 'No threads match';

/** The words typed, folded; none: no filter. */
export function titleWords(query: string): string[] {
  return fold(query).split(/\s+/u).filter(Boolean);
}

// A row's title as matching sees it, once per row object (a list read brings new rows, so this never goes stale).
const folded = new WeakMap<InboxListRow, string>();
function titleText(row: InboxListRow): string {
  let text = folded.get(row);
  if (text === undefined) {
    const name = row.thread_name?.trim() ?? '';
    const subject = row.subject ?? '';
    text = fold(name && name !== subject ? `${name}\n${subject}` : subject);
    folded.set(row, text);
  }
  return text;
}

/** The row's title holds every word. */
export function rowMatchesTitle(row: InboxListRow, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const text = titleText(row);
  return words.every((word) => text.includes(word));
}

/** The rows whose title holds every word of `query`; the same array when nothing is typed. */
export function filterRowsByTitle<T extends InboxListRow>(rows: readonly T[], query: string): readonly T[] {
  const words = titleWords(query);
  return words.length === 0 ? rows : rows.filter((row) => rowMatchesTitle(row, words));
}

/** The list's sections with only the matching rows; the same sections when nothing is typed. */
export function filterSectionsByTitle<S extends InboxListSection>(sections: readonly S[], query: string): readonly S[] {
  const words = titleWords(query);
  if (words.length === 0) return sections;
  return sections.map((section) => ({ ...section, threads: section.threads.filter((row) => rowMatchesTitle(row, words)) }));
}
