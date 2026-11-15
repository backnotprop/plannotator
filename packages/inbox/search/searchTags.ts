/**
 * Search's Tag chip (approval "inbox-thread-tags", step 2; the owner: "It can be a filter but nothing more"): it narrows
 * the results to threads in any picked tag, and tags are never results. Search reads this Inbox's own threads, so the
 * menu offers the tags those carry (the host's `here`), and a pick is that tag's id, this Inbox's own: one id per tag,
 * each once. Pure: the palette draws the chip and its menu.
 */
import type { InboxInitiative } from '@plannotator/core/inbox-types';
import type { ListTag } from '../threadTags';

export const tagPicked = (tag: ListTag, picks: readonly string[]): boolean => picks.includes(tag.id);

/** The picks with the tag ticked or unticked. */
export function toggledTag(picks: readonly string[], tag: ListTag): string[] {
  return tagPicked(tag, picks) ? picks.filter((id) => id !== tag.id) : [...picks, tag.id];
}

/** The picked tags that are live, in the tags' order. */
export const pickedTags = <T extends ListTag>(tags: readonly T[], picks: readonly string[]): T[] => tags.filter((tag) => tagPicked(tag, picks));

/** The chip's words: "Any tag", "Tagged Release", "Tagged Release or Windows". */
export function tagChipText(tags: readonly InboxInitiative[], picks: readonly string[]): string {
  const names = pickedTags(tags, picks).map((tag) => tag.name);
  return names.length === 0 ? 'Any tag' : `Tagged ${names.join(' or ')}`;
}
