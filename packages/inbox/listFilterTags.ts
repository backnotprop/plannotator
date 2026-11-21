/**
 * The list filter's Tag picks (approval "inbox-thread-tags", step 2) against the live tags. A pick is the tag's id
 * when it was ticked; across linked machines a tag's id can move to another machine's copy of its name
 * (threadTags.ts `tagById`), so a pick is read as the tag it names now. A pick whose tag is gone (deleted, or an
 * Inbox that keeps no tags) applies nothing and is not counted, and comes back with the tag's Undo.
 */
import type { ListFilter } from './listFilter';
import { tagById, type ListTag } from './threadTags';

/**
 * The filter with its Tag picks as the live tags' ids, those that name no live tag left out. `undefined`: the list is
 * not read yet, so the picks hold as they are (no moment of unfiltered rows); `null`: this Inbox keeps no tags.
 */
export function withLiveTagPicks(filter: ListFilter, tags: readonly ListTag[] | null | undefined): ListFilter {
  if (filter.tags.length === 0 || tags === undefined) return filter;
  const live = [...new Set(filter.tags.flatMap((id) => (tags ? (tagById(tags, id)?.id ?? []) : [])))];
  return live.length === filter.tags.length && live.every((id, i) => id === filter.tags[i]) ? filter : { ...filter, tags: live };
}

/** The remembered picks with `tag` ticked or unticked (every pick naming it goes on untick). */
export function toggledTagPick(picks: readonly string[], tag: ListTag, tags: readonly ListTag[]): string[] {
  const naming = picks.filter((id) => tagById(tags, id)?.id === tag.id);
  return naming.length > 0 ? picks.filter((id) => !naming.includes(id)) : [...picks, tag.id];
}
