/**
 * Search's Tag chip (approval "inbox-thread-tags", step 2; the owner: "It can be a filter but nothing more"): it narrows
 * the results to threads in any picked tag, and tags are never results. A pick is kept as every machine's id of the
 * tag (`machines`), so the server matches its own tag whichever id the window lists it by; an id it has no tag for
 * matches nothing. Pure: the palette draws the chip and its menu.
 */
import type { InboxInitiative } from '@plannotator/core/inbox-types';
import type { ListTag } from '../threadTags';

/** Every id of the tag: the list's, and its id on each machine that holds one of its name. */
export function tagIds(tag: ListTag): string[] {
  return [...new Set([tag.id, ...Object.values(tag.machines ?? {})])];
}

export const tagPicked = (tag: ListTag, picks: readonly string[]): boolean => tagIds(tag).some((id) => picks.includes(id));

/** The picks with the tag ticked or unticked. */
export function toggledTag(picks: readonly string[], tag: ListTag): string[] {
  const ids = tagIds(tag);
  return tagPicked(tag, picks) ? picks.filter((id) => !ids.includes(id)) : [...picks, ...ids];
}

/** The picked tags that are live, in the tags' order. */
export const pickedTags = <T extends ListTag>(tags: readonly T[], picks: readonly string[]): T[] => tags.filter((tag) => tagPicked(tag, picks));

/** The chip's words: "Any tag", "Tagged Release", "Tagged Release or Windows". */
export function tagChipText(tags: readonly InboxInitiative[], picks: readonly string[]): string {
  const names = pickedTags(tags, picks).map((tag) => tag.name);
  return names.length === 0 ? 'Any tag' : `Tagged ${names.join(' or ')}`;
}
