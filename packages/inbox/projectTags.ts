/**
 * Project tags (the owner, 2026-11-18: "Let a project carry a tag (for example Work or Personal), and let the existing
 * filter pick that tag, so the Board and the list can show a set of projects"; storage: shared/inbox/project-tags.ts).
 *
 * A project tag is a thread tag put on a project from its ⋯ (Add tag). The rule the filters read: a thread is in a tag
 * when it is tagged itself, or its project carries the tag; a Board card is in a tag when that is its own tag, or its
 * project carries it. Only the filters read it: the list's Tag group (its rows, their counts and what a pick keeps) and
 * the Board's Tag pick (its counts and its cards). A row's own tags, its colour, a tag's own list in the sidebar and the
 * Board's "No tag" (a card with no tag of its own) do not change. With no project tagged nothing does.
 *
 * Pure: no routes or server calls.
 */
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { ProjectFolder } from './api';

/** Each tagged project's tags, by its id. */
export type ProjectTagMap = ReadonlyMap<string, readonly string[]>;

const NONE: ProjectTagMap = new Map();

/** The tagged projects' tags, what this window just set (`patches`) over what the list said. */
export function projectTagMap(projects: readonly Pick<ProjectFolder, 'id' | 'tags'>[] | null | undefined, patches?: ProjectTagMap): ProjectTagMap {
  if (!projects?.some((p) => (p.tags?.length ?? 0) > 0) && !patches?.size) return NONE;
  const out = new Map<string, readonly string[]>();
  for (const project of projects ?? []) if (project.tags && project.tags.length > 0) out.set(project.id, project.tags);
  for (const [id, tags] of patches ?? []) out.set(id, tags);
  return out;
}

/**
 * A row's tags for the filters: its own (`own`, the window's rule) and its project's, each once. With no project
 * tagged, `own` itself: the filters read exactly what they read before.
 */
export function withProjectTags<R extends Pick<InboxListRow, 'project'>>(own: (row: R) => readonly string[], map: ProjectTagMap): (row: R) => readonly string[] {
  if (map.size === 0) return own;
  return (row) => {
    const extra = map.get(row.project.id);
    if (!extra || extra.length === 0) return own(row);
    const mine = own(row);
    return mine.length === 0 ? extra : [...new Set([...mine, ...extra])];
  };
}

/** A Board card is in `tag`: its own tag, or its project's. */
export function cardInTag(card: { initiative?: string | null; project_id: string }, tag: string, map: ProjectTagMap): boolean {
  return card.initiative === tag || (map.get(card.project_id)?.includes(tag) ?? false);
}
