/**
 * What a sent tag previews with the Board off (approval "inbox-thread-tags", step 2):
 * the tag's name, "Tag · <projects> · N threads", its latest threads (the one the tag sits in left out), capped, the
 * rest "+N more". The threads are the window's rows in the tag, a linked machine's too, read by the window's rule
 * (`rowTagsHere`). Pure: InitiativePeek draws it.
 */
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { PEEK_THREADS, threadOf, type PeekThread } from './initiativePeek';
import type { RowTags } from './threadTags';

export interface TagPeekModel {
  /** Every listed thread in the tag, the one being read too. */
  total: number;
  /** The projects its threads are in, by name, the latest thread's first. */
  projects: string[];
  threads: PeekThread[];
  more: number;
}

export function tagPeekModel(tagId: string, rows: readonly InboxListRow[], rowTags: RowTags, projectNames: ReadonlyMap<string, string>, exclude: string | null): TagPeekModel {
  const seen = new Set<string>();
  const tagged: InboxListRow[] = [];
  for (const row of rows) {
    if (seen.has(row.thread_id) || !rowTags(row).includes(tagId)) continue;
    seen.add(row.thread_id);
    tagged.push(row);
  }
  tagged.sort((a, b) => b.last_at.localeCompare(a.last_at));
  const projects = [...new Set(tagged.map((row) => projectNames.get(row.project.id) ?? row.project.name))];
  const others = tagged.filter((row) => row.thread_id !== exclude);
  return { total: tagged.length, projects, threads: others.slice(0, PEEK_THREADS).map(threadOf), more: Math.max(0, others.length - PEEK_THREADS) };
}
