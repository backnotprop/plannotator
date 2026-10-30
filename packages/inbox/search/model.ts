/**
 * Inbox search's palette, the parts with no React: the options it lists (in
 * the approved group order, with "Show all" rows), where each result opens,
 * the filter chips' words, and what the live region says. The palette
 * (SearchPalette.tsx) draws these; the DOM tests read them too.
 */

import type { ComposeAction } from '../compose/model';
import {
  INBOX_SEARCH_GROUPS,
  type InboxSearchFrom,
  type InboxSearchGroupId,
  type InboxSearchRow,
  type InboxSearchStatus,
  type InboxSearchThreadRow,
} from '@plannotator/core/inbox-search';
import { INBOX_SECTIONS, type InboxSectionId } from '@plannotator/core/inbox-types';
import { threadChipName } from '../threadChip';

export const GROUP_LABELS: Readonly<Record<InboxSearchGroupId, { heading: string; noun: string }>> = {
  threads: { heading: 'Threads', noun: 'threads' },
  messages: { heading: 'Messages', noun: 'messages' },
  files: { heading: 'Files', noun: 'files' },
  projects: { heading: 'Projects', noun: 'projects' },
};

/** One option of the listbox. */
export type SearchOption =
  | { kind: 'row'; group: InboxSearchGroupId | 'recent'; row: InboxSearchRow }
  // Compose's actions (the "Actions" group): "New message…" and "Message <host> in <project>".
  | { kind: 'action'; action: ComposeAction }
  | { kind: 'more'; group: InboxSearchGroupId; total: number; shown: number }
  | { kind: 'recent-q'; q: string };

export interface SearchGroupView {
  id: InboxSearchGroupId | 'recent' | 'recent-searches' | 'actions';
  heading: string;
  /** The group's total when it holds more than it shows (the heading's quiet count). */
  total: number | null;
  options: SearchOption[];
}

export interface SearchFilters {
  project: string | null;
  status: InboxSearchStatus | null;
  from: InboxSearchFrom | null;
}

export const NO_FILTERS: SearchFilters = { project: null, status: null, from: null };

export const filtersSet = (filters: SearchFilters): boolean => Boolean(filters.project || filters.status || filters.from);

/** The rows "Show 50 more" adds at a time, and the most one group shows before it. */
export const SEARCH_PAGE = 50;

/**
 * The groups as the palette lists them: the recent view (recent searches,
 * then the threads looked at last), or the result groups in their fixed
 * order, each ending with "Show all N …" (or "Show 50 more") while it holds
 * more than it shows. A group with no rows is left out.
 */
export function searchGroups(
  answer: { groups: Partial<Record<InboxSearchGroupId, InboxSearchRow[]>> | null; totals: Record<InboxSearchGroupId, number> | null; recent: InboxSearchThreadRow[] | null; recent_searches?: string[] } | null,
  expanded: Partial<Record<InboxSearchGroupId, InboxSearchRow[]>> = {},
): SearchGroupView[] {
  if (!answer) return [];
  if (answer.recent) {
    const out: SearchGroupView[] = [];
    const searches = answer.recent_searches ?? [];
    if (searches.length > 0) out.push({ id: 'recent-searches', heading: 'Recent searches', total: null, options: searches.map((q) => ({ kind: 'recent-q', q })) });
    if (answer.recent.length > 0) out.push({ id: 'recent', heading: 'Recent', total: null, options: answer.recent.map((row) => ({ kind: 'row', group: 'recent', row })) });
    return out;
  }
  const out: SearchGroupView[] = [];
  for (const id of INBOX_SEARCH_GROUPS) {
    const rows = expanded[id] ?? answer.groups?.[id] ?? [];
    if (rows.length === 0) continue;
    const total = answer.totals?.[id] ?? rows.length;
    const options: SearchOption[] = rows.map((row) => ({ kind: 'row', group: id, row }));
    if (total > rows.length) options.push({ kind: 'more', group: id, total, shown: rows.length });
    out.push({ id, heading: GROUP_LABELS[id].heading, total: total > rows.length ? total : null, options });
  }
  return out;
}

const numbers = new Intl.NumberFormat('en-US');
export const formatCount = (n: number): string => numbers.format(n);

/** "Show all 23 messages", or, once a group is open, "Show 50 more". */
export function moreLabel(option: Extract<SearchOption, { kind: 'more' }>): string {
  if (option.shown >= SEARCH_PAGE) return `Show ${formatCount(Math.min(SEARCH_PAGE, option.total - option.shown))} more`;
  return `Show all ${formatCount(option.total)} ${GROUP_LABELS[option.group].noun}`;
}

/** Where a result opens: the window's hash, and for a message the landing (the query's terms, a question's key). */
export function resultTarget(row: InboxSearchRow, terms: readonly string[]): { hash: string; land: { messageId: string; terms: string[]; questionKey: string | null } | null } {
  const enc = encodeURIComponent;
  switch (row.type) {
    case 'thread':
      return { hash: `#thread=${enc(row.thread_id)}`, land: null };
    case 'message':
      return { hash: `#thread=${enc(row.thread_id)}&msg=${enc(row.id)}`, land: { messageId: row.id, terms: [...terms], questionKey: row.question?.key ?? null } };
    case 'file':
      return { hash: `#thread=${enc(row.thread_id)}&file=${enc(row.id)}`, land: null };
    case 'guide':
      return { hash: `#thread=${enc(row.thread_id)}&guide=${enc(row.message_id)}`, land: null };
    case 'project':
      return { hash: `#project=${enc(row.id)}`, land: null };
  }
}

export const STATUS_OPTIONS: readonly { value: InboxSearchStatus | null; label: string }[] = [
  { value: null, label: 'Any status' },
  { value: 'waiting', label: 'Waiting on you' },
  { value: 'new', label: 'New since you looked' },
  { value: 'sent', label: 'Sent' },
  { value: 'quiet', label: 'Quiet' },
  { value: 'archived', label: 'Archived' },
];

export const FROM_OPTIONS: readonly { value: InboxSearchFrom | null; label: string }[] = [
  { value: null, label: 'Anyone' },
  { value: 'agent', label: 'Agents' },
  { value: 'me', label: 'Me' },
];

/** What a set chip reads: "in plannotator", "Archived", "From me". */
export function chipText(kind: keyof SearchFilters, filters: SearchFilters, projectName: (id: string) => string): string {
  if (kind === 'project') return filters.project ? `in ${projectName(filters.project)}` : 'All projects';
  if (kind === 'status') return STATUS_OPTIONS.find((o) => o.value === filters.status)?.label ?? 'Any status';
  return filters.from === 'me' ? 'From me' : filters.from === 'agent' ? 'From agents' : 'From anyone';
}

/** Project names as the person reads them: a second project with the same name gets its parent folder ("api · work"). */
export function projectNames(projects: readonly { id: string; name: string; root: string }[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const p of projects) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const p of projects) {
    const parts = p.root.split(/[\\/]+/).filter(Boolean);
    const parent = parts.length >= 2 ? parts[parts.length - 2] : null;
    out.set(p.id, (counts.get(p.name) ?? 0) > 1 && parent ? `${p.name} · ${parent}` : p.name);
  }
  return out;
}

/** "Searched only plannotator, Archived": the scope a "No matches" names. */
export function scopeWords(filters: SearchFilters, projectName: (id: string) => string): string[] {
  const out: string[] = [];
  if (filters.project) out.push(projectName(filters.project));
  if (filters.status) out.push(STATUS_OPTIONS.find((o) => o.value === filters.status)!.label);
  if (filters.from) out.push(filters.from === 'me' ? 'From me' : 'From agents');
  return out;
}

const SECTION_LABELS = new Map(INBOX_SECTIONS.map((s) => [s.id, s.label] as const));
export const sectionLabel = (id: InboxSectionId | null): string | null => (id ? (SECTION_LABELS.get(id) ?? null) : null);

/** What the live region says once an answer has landed (never per keystroke). */
export function countWords(answer: { totals: Record<InboxSearchGroupId, number> | null; recent: unknown; indexing?: boolean } | null, q: string, filtered: boolean): string {
  if (!answer || answer.indexing) return '';
  if (answer.recent) return '';
  const totals = answer.totals;
  if (!totals) return '';
  const groups = INBOX_SEARCH_GROUPS.filter((id) => totals[id] > 0);
  const n = groups.reduce((sum, id) => sum + totals[id], 0);
  if (n === 0) return q.trim() ? `No matches for ${q.trim()}` : filtered ? 'No threads match these filters' : '';
  return `${formatCount(n)} ${n === 1 ? 'result' : 'results'} in ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}`;
}

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** A result's time as the mock draws it: "11:42 AM" today, "Oct 9" this year, "Sep 2, 2025" before. */
export function searchTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (date.getFullYear() !== now.getFullYear()) return DAY_YEAR.format(date);
  if (date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return TIME.format(date);
  return DAY.format(date);
}

/** Text and marks ([start, length]) as alternating runs, for drawing the matched words in semibold. */
export function markedRuns(text: string, marks: readonly [number, number][]): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [start, length] of [...marks].sort((a, b) => a[0] - b[0])) {
    if (start < at || length <= 0) continue;
    if (start > at) out.push({ text: text.slice(at, start), mark: false });
    out.push({ text: text.slice(start, start + length), mark: true });
    at = start + length;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}

/** Text as compared for "the row already shows it": a cut's "…" dropped, whitespace as one space, case folded. */
const sameText = (text: string): string =>
  text
    .replace(/^\s*…|…\s*$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase();

/** The shortest first line that counts as showing the thread's subject when it is a piece of it (a word or two is not). */
const SHOWN_MIN = 12;

/** The thread chip a result row draws: the list's chip (`.ib-key`), on the row's second line. */
export interface RowThreadChip {
  /** What the chip says: the thread's name, or its subject when it has none. */
  text: string;
  kind: 'name' | 'subject';
  /** The thread's subject, for the chip's title and its accessible words. */
  subject: string;
}

/**
 * The one thread chip a result draws, in the form the list uses for a thread.
 *
 * - A thread row: the list's own rule (`threadChipName`): its name, unless its
 *   subject (the row's first line) already starts with it; no name, no chip.
 * - A message, file or guided review: the thread's name; with no name, the
 *   thread's subject in the chip. That subject chip is left out only when the row's first line is the subject,
 *   begins with it, or is a start of it at least 12 characters long (a message
 *   whose words became the subject); never for a word or two met inside the
 *   text ("Deploy" in "We should deploy tomorrow").
 * - A project: none.
 */
export function rowThreadChip(row: InboxSearchRow): RowThreadChip | null {
  if (row.type === 'project') return null;
  const subject = row.title ?? null;
  if (!subject) return null;
  if (row.type === 'thread') {
    const name = threadChipName(row.thread_name, subject);
    return name ? { text: name, kind: 'name', subject } : null;
  }
  if (row.thread_name) return { text: row.thread_name, kind: 'name', subject };
  const first = sameText(row.type === 'message' ? row.snippet.text : row.name);
  const wanted = sameText(subject);
  const shown = wanted.length > 0 && (first.startsWith(wanted) || (first.length >= SHOWN_MIN && wanted.startsWith(first)));
  return shown ? null : { text: subject, kind: 'subject', subject };
}

