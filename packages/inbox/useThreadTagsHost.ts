import { useCallback, useMemo, useRef, useState } from 'react';
import type { InboxInitiative, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { inboxApi } from './api';
import { machineOf } from './inboxUrl';
import { setSidebarSectionOpen } from './sidebarSections';
import { canTagThread, rowTagsHere, tagsSectionShown, tagThreadCounts, tagWaitingCounts, type ThreadTagsHost } from './threadTags';
import { initiativeDeletedToast } from './board/model';
import { restoreInitiatives } from './board/initiativeUndo';
import type { InboxToastModel } from './components/Toast';

function withEntry<V>(map: ReadonlyMap<string, V>, key: string, value: V | undefined): ReadonlyMap<string, V> {
  const next = new Map(map);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
}

interface TagsInputs {
  listTags: readonly InboxInitiative[] | null;
  routeTag: string | null;
  self: string | null;
  windowRows: readonly InboxListRow[];
  latestSections: readonly InboxListSection[];
  rowOf: (threadId: string) => InboxListRow | undefined;
  showError: (cause: unknown) => void;
  showToast: (toast: Omit<InboxToastModel, 'id'>) => void;
  dismissToast: () => void;
  refreshList: (adopt: boolean) => Promise<unknown>;
  openTag: (tagId: string) => void;
  tagGone: (tagId: string) => void;
}

export function useThreadTagsHost({ listTags, routeTag, self, windowRows, latestSections, rowOf, showError, showToast, dismissToast, refreshList, openTag, tagGone }: TagsInputs) {
  const [tagPatches, setTagPatches] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map());
  const tagsOfRow = useCallback((row: Pick<InboxListRow, 'thread_id' | 'tags' | 'machine'>) => rowTagsHere(row, self, tagPatches), [tagPatches, self]);
  const filterTag = routeTag ? (listTags?.find((tag) => tag.id === routeTag) ?? null) : null;
  const tagCounts = useMemo(() => tagThreadCounts(windowRows, tagsOfRow), [windowRows, tagsOfRow]);
  const tagWaiting = useMemo(() => tagWaitingCounts(latestSections, tagsOfRow), [latestSections, tagsOfRow]);
  const tagsShown = listTags !== null && tagsSectionShown(listTags, windowRows, tagsOfRow);
  const setThreadTag = async (threadId: string, tag: InboxInitiative, on: boolean, undo = true) => {
    const before = tagPatches.get(threadId) ?? rowOf(threadId)?.tags ?? [];
    const next = on ? (before.includes(tag.id) ? before : [...before, tag.id]) : before.filter((id) => id !== tag.id);
    setTagPatches((current) => withEntry<readonly string[]>(current, threadId, next));
    const unpatch = () => setTagPatches((current) => withEntry<readonly string[]>(current, threadId, undefined));
    try {
      await inboxApi.setThreadTag(threadId, tag.id, on);
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
  const setThreadTagRef = useRef(setThreadTag);
  setThreadTagRef.current = setThreadTag;
  const createTagRef = useRef(createTag);
  createTagRef.current = createTag;
  const threadTagsHost = useMemo<ThreadTagsHost | null>(
    () =>
      listTags === null
        ? null
        : {
            tags: listTags,
            tagsOf: (threadId) => {
              const row = windowRows.find((r) => r.thread_id === threadId);
              return row ? rowTagsHere(row, self, tagPatches) : (tagPatches.get(threadId) ?? []);
            },
            counts: tagCounts,
            can: (threadId) => canTagThread(threadId, windowRows, self, machineOf(threadId)),
            set: (threadId, tag, on) => void setThreadTagRef.current(threadId, tag, on),
            createAndSet: (threadId, name) =>
              void createTagRef.current(name).then((tag) => {
                if (tag) void setThreadTagRef.current(threadId, tag, true);
              }),
            listed: filterTag,
          },
    [listTags, tagPatches, windowRows, tagCounts, self, filterTag],
  );
  const deleteTag = async (tag: InboxInitiative) => {
    try {
      await inboxApi.changeInitiative(tag.id, { op: 'delete' });
    } catch (cause) {
      showError(cause);
      return;
    }
    tagGone(tag.id);
    await refreshList(false);
    showToast({ icon: 'check', ...initiativeDeletedToast([tag]), onUndo: () => void undoDeleteTag(tag) });
  };
  const undoDeleteTag = async (tag: InboxInitiative) => {
    dismissToast();
    const { left, line } = await restoreInitiatives([tag]);
    if (line) showToast({ icon: 'warn', wrap: true, lead: line, ...(left.length > 0 ? { onUndo: () => void undoDeleteTag(tag) } : {}) });
    await refreshList(false);
  };
  const sidebarTags =
    listTags === null
      ? undefined
      : {
          tags: listTags,
          waiting: tagWaiting,
          shown: tagsShown,
          tagId: routeTag,
          onOpen: openTag,
          onCreate: async (name: string) => {
            const tag = await createTag(name);
            if (!tag) return null;
            await refreshList(false);
            return tag.id;
          },
          onRename: async (tagId: string, name: string) => {
            try {
              await inboxApi.changeInitiative(tagId, { op: 'rename', name });
            } catch (cause) {
              showError(cause);
              return false;
            }
            await refreshList(false);
            return true;
          },
          onDelete: (tag: InboxInitiative) => void deleteTag(tag),
        };
  return { tagsOfRow, filterTag, threadTagsHost, sidebarTags };
}
