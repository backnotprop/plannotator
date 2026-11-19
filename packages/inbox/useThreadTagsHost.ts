import { useCallback, useMemo, useRef, useState } from 'react';
import { inboxNextTagColour, inboxTagLook, inboxTagLookColour, inboxTagShownHex, type InboxInitiative, type InboxListRow, type InboxListSection, type InboxTagColours, type InboxTagLook } from '@plannotator/core/inbox-types';
import { inboxApi } from './api';
import type { MachinesModel } from './machines';
import { machineOf } from './inboxUrl';
import { setSidebarSectionOpen } from './sidebarSections';
import { canTagThread, rowTagsHere, tagById, tagsOnOwnRows, threadTagsHere, tagsSectionShown, tagThreadCounts, tagWaitingCounts, tagWrite, type ListTag, type ThreadTagsHost } from './threadTags';
import { initiativeDeletedToast } from './board/model';
import { showTagColoursAcross, type TagsAcross } from './tagsAcross';
import { rowTint } from './tagColours';
import { keepTints } from './tagTintSheet';
import type { ListTagColours } from './parts/RowTint';
import type { InboxToastModel } from './components/Toast';
import { eachRow, tagsToast } from './bulkWrites';
import { useProjectTags } from './useProjectTags';
import { tagWrites } from './tagWrites';
import type { ProjectFolder } from './api';

const NO_PROJECTS: readonly ProjectFolder[] = [];

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
  /** The open thread's own read's row: an archived thread's tags (the list leaves it out). */
  openRow?: InboxListRow | null;
  latestSections: readonly InboxListSection[];
  rowOf: (threadId: string) => InboxListRow | undefined;
  showError: (cause: unknown) => void;
  showToast: (toast: Omit<InboxToastModel, 'id'>) => void;
  dismissToast: () => void;
  refreshList: (adopt: boolean) => Promise<unknown>;
  openTag: (tagId: string) => void;
  tagGone: (tag: ListTag) => void;
  /** The list's `tag_colours`; null from an Inbox before tag colours (then no row is tinted and the menus offer none). */
  tagColours: InboxTagColours | null;
  /** The list's projects: their tags (useProjectTags.ts). */
  projects?: readonly ProjectFolder[];
}

/** The colour menu of a sidebar tag (TagsSection): what it shows and what a pick does. */
export interface TagColourControls {
  /** "Show tag colors": off, no sidebar tag is tinted either. */
  show: boolean;
  /** What the tag's rows show: its colour, or null with Highlight rows off. */
  colourOf: (tagId: string) => string | null;
  /** The tag's colour, on or off (the Color item and the picker show it): the one kept while off, else the one it would get. */
  pickOf: (tagId: string) => string;
  /** The person's own colours, newest first (the menu's second line). */
  recent: readonly string[];
  /** A colour picked: drawn at once, Highlight rows on, written to every machine that holds the tag. */
  set: (tag: ListTag, colour: string) => void;
  /** Highlight rows on (the tag's colour back) or off (its colour kept): drawn at once and written. */
  highlight: (tag: ListTag, on: boolean) => void;
  /** Drawn at once, not written (the hue strip while it is dragged); `set` or `preview(tag, undefined)` ends it. */
  preview: (tag: ListTag, colour: string | null | undefined) => void;
}

export type { ListTagColours };

export function useThreadTagsHost({ listTags, across, routeTag, machines, windowRows, openRow, latestSections, rowOf, showError, showToast, dismissToast, refreshList, openTag, tagGone, tagColours, projects = NO_PROJECTS }: TagsInputs) {
const [tagPatches, setTagPatches] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map());
  // Of two quick ticks, only the latest write takes its tick back (tagWrites.ts).
  const [tagWritesHere] = useState(tagWrites);
  const tagsOfRow = useCallback((row: Pick<InboxListRow, 'thread_id' | 'tags' | 'machine'>) => rowTagsHere(row, machines, tagPatches), [tagPatches, machines]);
  // Project tags (projectTags.ts): the filters read a row's own tags and its project's; the project's ⋯ sets them.
  const { filterTagsOfRow, projectTagsHost } = useProjectTags({ projects, machines, tagsOfRow, showError, showToast, dismissToast, refreshList });
  const filterTag = routeTag && listTags ? tagById(listTags, routeTag) : null;
  const shownTagId = filterTag?.id ?? routeTag;
  const tagCounts = useMemo(() => tagThreadCounts(windowRows, tagsOfRow), [windowRows, tagsOfRow]);
  const tagWaiting = useMemo(() => tagWaitingCounts(latestSections, tagsOfRow), [latestSections, tagsOfRow]);
  const tagsHere = useMemo(() => (listTags ? tagsOnOwnRows(listTags, windowRows, machines.self, tagsOfRow) : []), [listTags, windowRows, machines.self, tagsOfRow]);
  const tagsShown = listTags !== null && tagsSectionShown(listTags, windowRows, tagsOfRow);
  const setThreadTag = async (threadId: string, tag: ListTag, on: boolean, undo = true) => {
    const before = tagPatches.get(threadId) ?? rowOf(threadId)?.tags ?? (openRow?.thread_id === threadId ? openRow.tags : undefined) ?? [];
    const next = on ? (before.includes(tag.id) ? before : [...before, tag.id]) : before.filter((id) => id !== tag.id);
    if (tag.id) setTagPatches((current) => withEntry<readonly string[]>(current, threadId, next));
    const turn = tagWritesHere.start(threadId);
    // Only the latest write on the thread takes its tick back (two quick ticks never flicker).
    const unpatch = () => {
      if (tagWritesHere.latest(threadId, turn)) setTagPatches((current) => withEntry<readonly string[]>(current, threadId, undefined));
    };
    try {
      await inboxApi.setThreadTag(threadId, tagWrite(tag, machineOf(threadId), machines.self), on);
    } catch (cause) {
      unpatch();
      showError(cause);
      return;
    }
    if (on) setSidebarSectionOpen('tags', true);
    // A thread the list leaves out (archived) is not read again with it: its write stays drawn.
    await refreshList(false).finally(() => {
      if (rowOf(threadId)) unpatch();
    });
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
  /** The picks' Add tag: each thread through its own machine (`tagWrite`), one toast and one Undo for them all. */
  const setThreadsTag = async (threadIds: readonly string[], tag: ListTag, on: boolean, undo = true) => {
    const rows = threadIds.map((id) => rowOf(id)).filter((row): row is InboxListRow => !!row);
    const outcomes = await eachRow(rows, (row) => inboxApi.setThreadTag(row.thread_id, tagWrite(tag, machineOf(row.thread_id), machines.self), on));
    const made = outcomes.filter((o) => o.ok).map((o) => o.row.thread_id);
    if (on && made.length > 0) setSidebarSectionOpen('tags', true);
    await refreshList(false);
    if (!undo) {
      const refused = outcomes.find((o) => !o.ok);
      if (refused && !refused.ok) showError(refused.cause);
      else dismissToast();
      return;
    }
    const copy = tagsToast(outcomes, tag.name, on);
    if (!copy) {
      const refused = outcomes.find((o) => !o.ok);
      if (refused && !refused.ok) showError(refused.cause);
      return;
    }
    showToast({ ...copy, onUndo: () => void setThreadsTag(made, tag, !on, false) });
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
            tagsOf: (threadId) => threadTagsHere(threadId, windowRows, openRow ?? null, machines, tagPatches),
            counts: tagCounts,
            can: (threadId) => canTagThread(threadId, windowRows, machines, machineOf(threadId)),
            set: (threadId, tag, on) => void setThreadTagRef.current(threadId, tag, on),
            setMany: (threadIds, tag, on) => void setThreadsTagRef.current(threadIds, tag, on),
            createAndSet: (threadId, name) =>
              machineOf(threadId)
                ? void setThreadTagRef.current(threadId, { id: '', name, created_at: '', created_by: { kind: 'person' }, updated_at: '', deleted_at: null }, true)
                : void createTagRef.current(name).then((tag) => {
                    if (tag) void setThreadTagRef.current(threadId, tag, true);
                  }),
            listed: filterTag,
            rows: windowRows,
            rowTags: tagsOfRow,
            here: tagsHere,
            filterTags: filterTagsOfRow,
            projects: projectTagsHost,
          },
    [listTags, tagPatches, windowRows, openRow, tagCounts, machines, filterTag, tagsOfRow, tagsHere, filterTagsOfRow, projectTagsHost],
  );
  const setThreadTagRef = useRef(setThreadTag);
  setThreadTagRef.current = setThreadTag;
  const setThreadsTagRef = useRef(setThreadsTag);
  setThreadsTagRef.current = setThreadsTag;
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
  // Tag colours (tagColours.ts): what this window just picked shows at once, until the list read after the write has
  // it; a colour being tried (the hue strip, a typed code) shows over it until it is kept or the menu closes.
  const [colourPatches, setColourPatches] = useState<ReadonlyMap<string, InboxTagLook>>(() => new Map());
  const [colourPreviews, setColourPreviews] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const [showPatch, setShowPatch] = useState<boolean | null>(null);
  const coloursKept = listTags !== null && tagColours !== null;
  const showColours = showPatch ?? tagColours?.show ?? true;
  const lookOf = useCallback((tagId: string): InboxTagLook | undefined => colourPatches.get(tagId) ?? (listTags ? tagById(listTags, tagId) : null)?.look, [colourPatches, listTags]);
  // The tint sheet keeps the colours tags store (with this window's picks not yet read back), before any row draws;
  // a colour being tried is drawn apart and never piles up (tagTintSheet.ts).
  useMemo(() => {
    if (listTags) keepTints(listTags.flatMap((t) => { const c = lookOf(t.id)?.colour; return c ? [{ key: c, hex: inboxTagShownHex(c) }] : []; }));
  }, [listTags, lookOf]);
  const colourOf = useCallback(
    (tagId: string): string | null => {
      if (colourPreviews.has(tagId)) return colourPreviews.get(tagId)!;
      return lookOf(tagId)?.colour ?? null;
    },
    [colourPreviews, lookOf],
  );
  // A tag never coloured (an earlier Inbox's None): the colour a new tag would get now, so the Color item names one and
  // turning Highlight rows on shows it.
  const pickOf = useCallback(
    (tagId: string): string =>
      inboxTagLookColour(lookOf(tagId)) ?? inboxNextTagColour((listTags ?? []).filter((t) => t.id !== tagId).map((t) => inboxTagLookColour(lookOf(t.id)))),
    [lookOf, listTags],
  );
  const recentKey = (tagColours?.recent ?? []).map((r) => r.colour).join(' ');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the colours, so a list read with the same ones keeps it
  const recent = useMemo(() => (recentKey ? recentKey.split(' ') : []), [recentKey]);
  const writeColour = async (tag: ListTag, colour: string | null, kept: string | null) => {
    if (!across) return;
    const at = new Date().toISOString();
    const look = inboxTagLook(colour, 'person', at, kept);
    setColourPreviews((current) => withEntry<string | null>(current, tag.id, undefined));
    setColourPatches((current) => withEntry(current, tag.id, look));
    const { refused, held } = await across.colour(tag, colour, at, kept);
    await refreshList(false);
    setColourPatches((current) => (current.get(tag.id) === look ? withEntry<InboxTagLook>(current, tag.id, undefined) : current));
    if (refused) showError(refused);
    else if (held) showError(held);
  };
  const writeColourRef = useRef(writeColour);
  writeColourRef.current = writeColour;
  const colourControls = useMemo<TagColourControls | null>(
    () =>
      coloursKept
        ? {
            show: showColours,
            colourOf,
            pickOf,
            recent,
            // Picking a colour while Highlight rows is off turns it on: the person chose it to see it.
            set: (tag, colour) => void writeColourRef.current(tag, colour, null),
            highlight: (tag, on) => void writeColourRef.current(tag, on ? pickOf(tag.id) : null, on ? null : pickOf(tag.id)),
            preview: (tag, colour) => setColourPreviews((current) => withEntry<string | null>(current, tag.id, colour)),
          }
        : null,
    [coloursKept, showColours, colourOf, pickOf, recent],
  );
  const setShow = useCallback(
    async (on: boolean) => {
      setShowPatch(on);
      const { refused, held } = await showTagColoursAcross(on, new Date().toISOString(), machines);
      await refreshList(false);
      setShowPatch(null);
      if (refused) showError(refused);
      else if (held) showError(held);
    },
    [machines, refreshList, showError],
  );
  // Search's results find a thread's row by its id (App's `rowOf`, a new function each draw: read through a ref).
  const rowOfRef = useRef(rowOf);
  rowOfRef.current = rowOf;
  const listColours = useMemo<ListTagColours | null>(() => {
    // A phone's list has no `tag_colours` (its keys are fixed): its rows still tint by each tag's `look`, with no switch.
    if (listTags === null) return null;
    const tintOf: ListTagColours['tintOf'] = (row) => (showColours && listTags ? rowTint(tagsOfRow(row), listTags, colourOf, shownTagId) : null);
    return {
      show: showColours,
      setShow: coloursKept ? (on) => void setShow(on) : undefined,
      tintOf,
      tintOfThread: (threadId) => {
        const row = rowOfRef.current(threadId);
        return row ? tintOf(row) : null;
      },
    };
  }, [coloursKept, showColours, setShow, listTags, tagsOfRow, colourOf, shownTagId]);
  return { tagsOfRow, filterTagsOfRow, filterTag, shownTagId, threadTagsHost, sidebarTags: sidebarTags && { ...sidebarTags, colours: colourControls }, listColours };
}
