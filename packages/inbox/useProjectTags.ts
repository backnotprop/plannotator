/**
 * The projects' tags in the window (projectTags.ts): what the project's ⋯ → Add tag ticks, unticks and makes, drawn at
 * once and written to the machine whose project it is, with the thread tag's toast and Undo ("Tagged Work", "Removed
 * from Work"). A linked machine's project is tagged there by the tag's name, once that machine takes project tags
 * (mark `project-tags`); an older one's project offers no Add tag. Of two quick ticks, only the latest write takes its
 * tick back (tagWrites.ts).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { InboxInitiative, InboxListRow } from '@plannotator/core/inbox-types';
import { post, type ProjectFolder } from './api';
import { inboxUrl } from './inboxUrl';
import type { MachinesModel } from './machines';
import { projectTagMap, withProjectTags, type ProjectTagMap } from './projectTags';
import { tagWrite, type ListTag, type ProjectTagsHost, type RowTags } from './threadTags';
import { tagWrites } from './tagWrites';
import type { InboxToastModel } from './components/Toast';

interface Inputs {
  projects: readonly ProjectFolder[];
  machines: Pick<MachinesModel, 'self' | 'linked'>;
  /** A row's own tags (rowTagsHere). */
  tagsOfRow: RowTags;
  showError: (cause: unknown) => void;
  showToast: (toast: Omit<InboxToastModel, 'id'>) => void;
  dismissToast: () => void;
  refreshList: (adopt: boolean) => Promise<unknown>;
}

/** The project's machine when it is a linked one, else null (this Inbox). */
function farOf(project: ProjectFolder | undefined, self: string | null): string | null {
  return project?.machine && project.machine !== self ? project.machine : null;
}

export function useProjectTags({ projects, machines, tagsOfRow, showError, showToast, dismissToast, refreshList }: Inputs) {
  const [patches, setPatches] = useState<ProjectTagMap>(() => new Map());
  const [writes] = useState(tagWrites);
  const map = useMemo(() => projectTagMap(projects, patches), [projects, patches]);
  /** A row's tags for the filters: its own and its project's. */
  const filterTagsOfRow = useMemo(() => withProjectTags<InboxListRow>(tagsOfRow, map), [tagsOfRow, map]);
  const patch = (id: string, tags: readonly string[] | undefined) =>
    setPatches((current) => {
      const next = new Map(current);
      if (tags === undefined) next.delete(id);
      else next.set(id, tags);
      return next;
    });
  const set = async (projectId: string, tag: ListTag | { name: string }, on: boolean, undo = true) => {
    const project = projects.find((p) => p.id === projectId);
    const far = farOf(project, machines.self);
    const before = map.get(projectId) ?? [];
    const id = 'id' in tag ? tag.id : '';
    if (id) patch(projectId, on ? [...before.filter((t) => t !== id), id] : before.filter((t) => t !== id));
    const turn = writes.start(projectId);
    // Only the latest write on the project takes its tick back (two quick ticks never flicker).
    const unpatch = () => {
      if (writes.latest(projectId, turn)) patch(projectId, undefined);
    };
    const body = 'id' in tag ? tagWrite(tag, far, machines.self) : { name: tag.name };
    try {
      await post<{ tags: string[] }>(inboxUrl(`/projects/${encodeURIComponent(projectId)}/tags`, undefined, far), { ...body, on });
    } catch (cause) {
      unpatch();
      showError(cause);
      return;
    }
    await refreshList(false).finally(unpatch);
    if (!undo) {
      dismissToast();
      return;
    }
    showToast({
      icon: 'check',
      lead: on ? 'Tagged' : 'Removed',
      detail: on ? tag.name : `from ${tag.name}`,
      speech: on ? `Tagged ${tag.name}.` : `Removed from ${tag.name}.`,
      onUndo: () => void setRef.current(projectId, tag, !on, false),
    });
  };
  const setRef = useRef(set);
  setRef.current = set;
  const can = useCallback(
    (projectId: string) => {
      const far = farOf(projects.find((p) => p.id === projectId), machines.self);
      return !far || machines.linked.some((m) => m.id === far && (m.marks ?? []).includes('project-tags'));
    },
    [projects, machines],
  );
  const host = useMemo<ProjectTagsHost>(
    () => ({
      can,
      target: (projectId) => ({
        on: map.get(projectId) ?? [],
        set: (tag: InboxInitiative, on: boolean) => void setRef.current(projectId, tag, on),
        create: (name: string) => void setRef.current(projectId, { name }, true),
      }),
    }),
    [can, map],
  );
  return { filterTagsOfRow, projectTagsHost: host };
}
