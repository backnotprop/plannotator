import { useCallback, useMemo, useRef, useState } from 'react';
import type { InboxInitiative, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { inboxApi } from './api';
import type { MachinesModel } from './machines';
import { machineOf } from './inboxUrl';
import { setSidebarSectionOpen } from './sidebarSections';
import { canTagThread, rowTagsHere, tagById, tagsSectionShown, tagThreadCounts, tagWaitingCounts, tagWrite, type ListTag, type ThreadTagsHost } from './threadTags';
import { initiativeDeletedToast } from './board/model';
import type { TagsAcross } from './tagsAcross';
import type { InboxToastModel } from './components/Toast';

function withEntry<V>(map: ReadonlyMap<string, V>, key: string, value: V | undefined): ReadonlyMap<string, V> {
  const next = new Map(map);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
}

interface TagsInputs {
  listTags: readonly ListTag[] | null;
  across: TagsAcross | null;
  routeTag: string | null;
  machines: MachinesModel;
  windowRows: readonly InboxListRow[];
  latestSections: readonly InboxListSection[];
  rowOf: (threadId: string) => InboxListRow | undefined;
  showError: (cause: unknown) => void;
  showToast: (toast: Omit<InboxToastModel, 'id'>) => void;
  dismissToast: () => void;
  refreshList: (adopt: boolean) => Promise<unknown>;
  openTag: (tagId: string) => void;
  tagGone: (tag: ListTag) => void;
}

export function useThreadTagsHost({ listTags, across, routeTag, machines, windowRows, latestSections, rowOf, showError, showToast, dismissToast, refreshList, openTag, tagGone }: TagsInputs) {
const [tagPatches, setTagPatches] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map());
  const tagsOfRow = useCallback((row: Pick<InboxListRow, 'thread_id' | 'tags' | 'machine'>) => rowTagsHere(row, machines, tagPatches), [tagPatches, machines]);
  const filterTag = routeTag && listTags ? tagById(listTags, routeTag) : null;
  const shownTagId = filterTag?.id ?? routeTag;
  const tagCounts = useMemo(() => tagThreadCounts(windowRows, tagsOfRow), [windowRows, tagsOfRow]);
  const tagWaiting = useMemo(() => tagWaitingCounts(latestSections, tagsOfRow), [latestSections, tagsOfRow]);
  const tagsShown = listTags !== null && tagsSectionShown(listTags, windowRows, tagsOfRow);
  const setThreadTag = async (threadId: string, tag: ListTag, on: boolean, undo = true) => {
    const before = tagPatches.get(threadId) ?? rowOf(threadId)?.tags ?? [];
    const next = on ? (before.includes(tag.id) ? before : [...before, tag.id]) : before.filter((id) => id !== tag.id);
    if (tag.id) setTagPatches((current) => withEntry<readonly string[]>(current, threadId, next));
    const unpatch = () => setTagPatches((current) => withEntry<readonly string[]>(current, threadId, undefined));
    try {
      await inboxApi.setThreadTag(threadId, tagWrite(tag, machineOf(threadId), machines.self), on);
    } catch (cause) {
      unpatch();
      showError(cause);
      return;
    }
    if (on) setSidebarSectionOpen('tags', true);
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
      onUndo: () => void setThreadTag(threadId, tag, !on, false),
    });
  };
  const createTag = async (name: string): Promise<InboxInitiative | null> => {
    try {
      return (await inboxApi.createInitiative(name)).initiative;
    } catch (cause) {
      showError(cause);
      return null;
    }
  };
  const threadTagsHost = useMemo<ThreadTagsHost | null>(
    () =>
      listTags === null
        ? null
        : {
            tags: listTags,
            tagsOf: (threadId) => {
              const row = windowRows.find((r) => r.thread_id === threadId);
              return row ? rowTagsHere(row, machines, tagPatches) : (tagPatches.get(threadId) ?? []);
            },
            counts: tagCounts,
            can: (threadId) => canTagThread(threadId, windowRows, machines, machineOf(threadId)),
            set: (threadId, tag, on) => void setThreadTagRef.current(threadId, tag, on),
            createAndSet: (threadId, name) =>
              machineOf(threadId)
                ? void setThreadTagRef.current(threadId, { id: '', name, created_at: '', created_by: { kind: 'person' }, updated_at: '', deleted_at: null }, true)
                : void createTagRef.current(name).then((tag) => {
                    if (tag) void setThreadTagRef.current(threadId, tag, true);
                  }),
            listed: filterTag,
          },
    [listTags, tagPatches, windowRows, tagCounts, machines, filterTag],
  );
  const setThreadTagRef = useRef(setThreadTag);
  setThreadTagRef.current = setThreadTag;
  const createTagRef = useRef(createTag);
  createTagRef.current = createTag;
  const sidebarTags = listTags === null
    ? undefined
    : {
        tags: listTags,
        waiting: tagWaiting,
        shown: tagsShown,
        tagId: shownTagId,
        onOpen: openTag,
        onCreate: async (name: string) => {
          const tag = await createTag(name);
          if (!tag) return null;
          await refreshList(false);
          return tag.id;
        },
        onRename: async (tagId: string, name: string) => {
          const tag = tagById(listTags, tagId);
          if (!tag || !across) return false;
          const taken = across.renameTaken(tag, name);
          if (taken) {
            showError(taken);
            return false;
          }
          const { refused, held } = await across.change(tag, { op: 'rename', name });
          await refreshList(false);
          if (refused) showError(refused);
          else if (held) showError(held);
          return !refused;
        },
        onDelete: (tag: InboxInitiative) => void deleteTag(tag),
      };
  const deleteTag = async (tag: ListTag) => {
    if (!across) return;
    const { refused } = await across.change(tag, { op: 'delete' });
    if (refused) {
      showError(refused);
      await refreshList(false);
      return;
    }
    tagGone(tag);
    await refreshList(false);
    showToast({ icon: 'check', ...initiativeDeletedToast([tag]), onUndo: () => void undoDeleteTag(tag) });
  };
  const undoDeleteTag = async (tag: ListTag) => {
    if (!across) return;
    dismissToast();
    const { left, line, refused } = await across.restore([tag]);
    if (line) showToast({ icon: 'warn', wrap: true, lead: line, ...(left.length > 0 ? { onUndo: () => void undoDeleteTag(tag) } : {}) });
    else if (refused) showError(refused);
    await refreshList(false);
  };
  return { tagsOfRow, filterTag, shownTagId, threadTagsHost, sidebarTags };
}
