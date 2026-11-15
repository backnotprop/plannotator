/**
 * Tags in Inbox search (approval "inbox-thread-tags", step 2): the window's tags, found in
 * the window, never on the server, so a linked machine's tags and threads are found as the list shows them.
 *
 * - `#rel` (a `#` first): the Tags group leads with every tag the name finds (those it starts first), then
 *   "Threads tagged <the first one>": its threads, the latest first. A bare `#` lists every tag.
 * - `rel` (plain words): the Tags group holds the tags whose name, or a word of it, starts with them, under the
 *   results.
 * A tag row opens the tag's list; a thread row opens the thread. Pure: the palette draws these.
 */
import type { InboxAuthor } from '@plannotator/core/inbox-types';
import { plural, shortTime } from '../format';
import { threadOf } from '../initiativePeek';
import { findTags, tagHref, type ThreadTagsHost } from '../threadTags';

/** The threads "Threads tagged …" lists at most: the tag's own list has them all. */
export const TAGGED_SHOWN = 8;

export interface SearchTag {
  id: string;
  name: string;
  /** "5 threads · 1 waiting on you". */
  meta: string;
  hash: string;
}

export interface SearchTaggedThread {
  id: string;
  title: string;
  agent: InboxAuthor;
  /** "plannotator · Nov 12". */
  meta: string;
  hash: string;
}

export interface TagSearch {
  /** The words started with `#`: the Tags group leads. */
  lead: boolean;
  tags: SearchTag[];
  tagged: { name: string; threads: SearchTaggedThread[] } | null;
}

const NONE: TagSearch = { lead: false, tags: [], tagged: null };

export function tagSearch(q: string, host: Pick<ThreadTagsHost, 'tags' | 'counts' | 'rows' | 'rowTags' | 'waiting'> | null, projectNames: (id: string) => string): TagSearch {
  const words = q.trim();
  if (!host || host.tags.length === 0 || !words) return NONE;
  const lead = words.startsWith('#');
  const name = (lead ? words.slice(1) : words).trim().toLocaleLowerCase();
  const startsAWord = (tag: { name: string }) => {
    const lower = tag.name.toLocaleLowerCase();
    return lower.startsWith(name) || lower.split(/\s+/).some((word) => word.startsWith(name));
  };
  const found = lead ? findTags(host.tags, name) : host.tags.filter(startsAWord);
  if (found.length === 0) return NONE;
  const tags = found.map((tag): SearchTag => {
    const waiting = host.waiting?.get(tag.id) ?? 0;
    return { id: tag.id, name: tag.name, meta: [plural(host.counts.get(tag.id) ?? 0, 'thread'), waiting > 0 ? `${waiting} waiting on you` : null].filter(Boolean).join(' · '), hash: tagHref(tag.id) };
  });
  if (!lead) return { lead, tags, tagged: null };
  const first = found[0]!;
  const rowTags = host.rowTags ?? ((row) => row.tags ?? []);
  const seen = new Set<string>();
  const rows = (host.rows ?? []).filter((row) => !seen.has(row.thread_id) && seen.add(row.thread_id) && rowTags(row).includes(first.id));
  rows.sort((a, b) => b.last_at.localeCompare(a.last_at));
  const threads = rows.slice(0, TAGGED_SHOWN).map((row): SearchTaggedThread => {
    const thread = threadOf(row);
    return { ...thread, meta: `${projectNames(row.project.id) || row.project.name} · ${shortTime(row.last_at)}`, hash: `#thread=${encodeURIComponent(row.thread_id)}` };
  });
  return { lead, tags, tagged: threads.length > 0 ? { name: first.name, threads } : null };
}
