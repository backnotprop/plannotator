import type { ComposeAction } from '../compose/model';
import {
  INBOX_SEARCH_GROUPS,
  inboxSearchRanges,
  type InboxSearchFrom,
  type InboxSearchGroupId,
  type InboxSearchRow,
  type InboxSearchStatus,
  type InboxSearchThreadRow,
} from '@plannotator/core/inbox-search';
import { INBOX_SECTIONS, inboxProjectDisplayName, type InboxSectionId } from '@plannotator/core/inbox-types';
import { threadChipName } from '../threadChip';

export const GROUP_LABELS: Readonly<Record<InboxSearchGroupId, { heading: string; noun: string; one: string }>> = {
  threads: { heading: 'Threads', noun: 'threads', one: 'thread' },
  messages: { heading: 'Messages', noun: 'messages', one: 'message' },
  files: { heading: 'Files', noun: 'files', one: 'file' },
  projects: { heading: 'Projects', noun: 'projects', one: 'project' },
};

export type SearchOption =
  | { kind: 'row'; group: InboxSearchGroupId | 'recent'; row: InboxSearchRow }
  | { kind: 'action'; action: ComposeAction }
  | { kind: 'more'; group: InboxSearchGroupId; total: number; shown: number }
  | { kind: 'recent-q'; q: string }
  | { kind: 'shape'; shape: SearchShape };

export interface SearchShape {
  id: string;
  title: string;
  project: string;
  meta: string;
  hash: string;
  picture: import('@plannotator/core/shape').ShapeDrawnView | null;
  refs: readonly import('@plannotator/core/shape').ShapeRef[];
}

export interface SearchGroupView {
  id: InboxSearchGroupId | 'recent' | 'recent-searches' | 'actions' | 'shapes';
  heading: string;
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

export const SEARCH_PAGE = 50;

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

export function moreLabel(option: Extract<SearchOption, { kind: 'more' }>): string {
  if (option.shown >= SEARCH_PAGE) return `Show ${formatCount(Math.min(SEARCH_PAGE, option.total - option.shown))} more`;
  return `Show all ${formatCount(option.total)} ${GROUP_LABELS[option.group].noun}`;
}

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

export function chipText(kind: keyof SearchFilters, filters: SearchFilters, projectName: (id: string) => string): string {
  if (kind === 'project') return filters.project ? `Only in ${projectName(filters.project)}` : 'All projects';
  if (kind === 'status') return STATUS_OPTIONS.find((o) => o.value === filters.status)?.label ?? 'Any status';
  return filters.from === 'me' ? 'From me' : filters.from === 'agent' ? 'From agents' : 'From anyone';
}

export function projectNames(projects: readonly { id: string; name: string; root: string; display_name?: unknown }[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const p of projects) if (inboxProjectDisplayName(p) === null) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const p of projects) {
    const given = inboxProjectDisplayName(p);
    if (given !== null) {
      out.set(p.id, given);
      continue;
    }
    const parts = p.root.split(/[\\/]+/).filter(Boolean);
    const parent = parts.length >= 2 ? parts[parts.length - 2] : null;
    out.set(p.id, (counts.get(p.name) ?? 0) > 1 && parent ? `${p.name} · ${parent}` : p.name);
  }
  return out;
}

export function scopeWords(filters: SearchFilters, projectName: (id: string) => string, type: InboxSearchGroupId | null = null): string[] {
  const out: string[] = [];
  if (type) out.push(filters.project ? `${GROUP_LABELS[type].noun} in ${projectName(filters.project)}` : GROUP_LABELS[type].noun);
  else if (filters.project) out.push(projectName(filters.project));
  if (filters.status) out.push(STATUS_OPTIONS.find((o) => o.value === filters.status)!.label);
  if (filters.from) out.push(filters.from === 'me' ? 'From me' : 'From agents');
  return out;
}

const SECTION_LABELS = new Map(INBOX_SECTIONS.map((s) => [s.id, s.label] as const));
export const sectionLabel = (id: InboxSectionId | null): string | null => (id ? (SECTION_LABELS.get(id) ?? null) : null);

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

export function typeCountWords(answer: { totals: Record<InboxSearchGroupId, number> | null; indexing?: boolean } | null, q: string, type: InboxSearchGroupId): string {
  if (!answer || answer.indexing || !answer.totals || !q.trim()) return '';
  const n = answer.totals[type];
  if (n === 0) return `No ${GROUP_LABELS[type].noun} match ${q.trim()}`;
  return `${formatCount(n)} ${n === 1 ? GROUP_LABELS[type].one : GROUP_LABELS[type].noun}`;
}

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function searchTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (date.getFullYear() !== now.getFullYear()) return DAY_YEAR.format(date);
  if (date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return TIME.format(date);
  return DAY.format(date);
}

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

export function termMarks(text: string, terms: readonly string[]): [number, number][] {
  return inboxSearchRanges(text, terms).map(([start, end]) => [start, end - start]);
}

export function projectMarks(shown: string, indexed: string, terms: readonly string[]): [number, number][] {
  if (terms.length === 0 || !indexed) return [];
  const at = shown.indexOf(indexed);
  if (at < 0) return [];
  return termMarks(indexed, terms).map(([start, length]) => [at + start, length]);
}

const sameText = (text: string): string =>
  text
    .replace(/^\s*…|…\s*$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase();

const SHOWN_MIN = 12;

export interface RowThreadChip {
  text: string;
  kind: 'name' | 'subject';
  subject: string;
}

export type SearchRowMark = { kind: 'agent'; host: string | null } | { kind: 'icon'; icon: 'user' | 'comment' | 'doc' | 'book' | 'folder' };

export function searchRowMark(row: InboxSearchRow): SearchRowMark {
  switch (row.type) {
    case 'message':
      return row.author.kind === 'me' ? { kind: 'icon', icon: 'user' } : { kind: 'agent', host: row.author.host ?? null };
    case 'thread':
      return { kind: 'icon', icon: 'comment' };
    case 'file':
      return { kind: 'icon', icon: 'doc' };
    case 'guide':
      return { kind: 'icon', icon: 'book' };
    case 'project':
      return { kind: 'icon', icon: 'folder' };
  }
}

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

