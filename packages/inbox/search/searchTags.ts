/**
 * Search's Tag chip (approval "inbox-thread-tags", step 2; the owner: "It can be a filter but nothing more"): it narrows
 * the results to threads in any picked tag, and tags are never results. The menu offers the tags the threads search
 * reads carry (the host's `here`: this Inbox's, and a linked machine's that takes the filter), and a pick is the tag's
 * id in the merged list, one per tag, each once; the search asks with every machine's id of it (`searchTagIds`).
 * Pure: the palette draws the chip and its menu.
 */
import type { InboxInitiative } from '@plannotator/core/inbox-types';
import type { ListTag } from '../threadTags';

export const tagPicked = (tag: ListTag, picks: readonly string[]): boolean => picks.includes(tag.id);

/** The picks with the tag ticked or unticked. */
export function toggledTag(picks: readonly string[], tag: ListTag): string[] {
  return tagPicked(tag, picks) ? picks.filter((id) => id !== tag.id) : [...picks, tag.id];
}

/**
 * What a search asks for the picks: each picked tag's id on every machine that holds it (`machines`), so each machine
 * filters by its own id of the same tag and ignores the rest. A pick no tag has any more is asked as it is.
 */
export function searchTagIds(tags: readonly ListTag[], picks: readonly string[]): string[] {
  const ids = picks.flatMap((pick) => {
    const tag = tags.find((one) => one.id === pick);
    return tag ? [tag.id, ...Object.values(tag.machines ?? {})] : [pick];
  });
  return [...new Set(ids)];
}

/** The picked tags that are live, in the tags' order. */
export const pickedTags = <T extends ListTag>(tags: readonly T[], picks: readonly string[]): T[] => tags.filter((tag) => tagPicked(tag, picks));

/** The chip's words: "Any tag", "Tagged Release", "Tagged Release or Windows". */
export function tagChipText(tags: readonly InboxInitiative[], picks: readonly string[]): string {
  const names = pickedTags(tags, picks).map((tag) => tag.name);
  return names.length === 0 ? 'Any tag' : `Tagged ${names.join(' or ')}`;
}
