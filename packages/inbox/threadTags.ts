/**
 * Thread tags in the window (approval "inbox-thread-tags", step 1): a tag is the Board's initiative, with the Board on
 * or off. The list model carries the live tags (`tags`) and each row's (`row.tags`); the sidebar's Tags section, a
 * tag's list (`#tag=ini_…`) and Add tag (the row's right-click menu and the thread's ⋯) read them from here.
 * Pure helpers, and the context App fills (`ThreadTagsContext`): absent on an older Inbox, which keeps no tags.
 *
 * Across linked machines a tag is one name (the store's rule, `inboxInitiativeNameKey`: trimmed, case ignored): the
 * merged list gives one tag per name with its id on each machine that holds it (`machines`), and a linked machine's
 * rows name those. A thread's tag lives on the thread's own machine, like its Priority.
 */
import { createContext, useContext } from 'react';
import { inboxInitiativeNameKey, type InboxInitiative, type InboxListRow, type InboxListSection } from '@plannotator/core/inbox-types';
import { plural } from '@plannotator/core/inbox-format';
import type { MachinesModel } from './machines';

/** What Add tag and the sidebar do with tags; null on an Inbox that keeps none. */
export interface ThreadTagsHost {
  /** The live tags, oldest first. */
  tags: readonly InboxInitiative[];
  /** The tags a thread is in (its row's `tags`, or what this window just set and the list has not read yet). */
  tagsOf: (threadId: string) => readonly string[];
  /** Threads per tag, every thread the window lists: the Add tag list's quiet number. */
  counts: ReadonlyMap<string, number>;
  /** Add tag is offered: a thread this Inbox holds, or a linked machine's that takes tags from here. */
  can: (threadId: string) => boolean;
  /** Put the thread in the tag or take it out; the toast says so, with Undo. */
  set: (threadId: string, tag: InboxInitiative, on: boolean) => void;
  /** Make a tag and put the thread in it (`New tag "Billing"`). */
  createAndSet: (threadId: string, name: string) => void;
  /** The tag whose list the window shows: its rows' menu offers Remove from <tag>. */
  listed: InboxInitiative | null;
}

export const ThreadTagsContext = createContext<ThreadTagsHost | null>(null);
export const useThreadTags = () => useContext(ThreadTagsContext);

/** A row's tags: `row.tags`, or what the window just set on it (App's patches). */
export type RowTags = (row: Pick<InboxListRow, 'thread_id' | 'tags' | 'machine'>) => readonly string[];
const ownTags: RowTags = (row) => row.tags ?? [];

/** A tag of the list: on the merged view, with its id on each machine that holds one of its name. */
export type ListTag = InboxInitiative & { machines?: Record<string, string> };

/** Whether `machine` (a row's, or a thread's owner) is this Inbox, or a linked machine that takes tags from it. */
function takesTags(machine: string | null | undefined, model: Pick<MachinesModel, 'self' | 'linked'>): boolean {
  if (!machine || machine === model.self) return true;
  return model.linked.some((m) => m.id === machine && (m.marks ?? []).includes('tags'));
}

/**
 * A row's tags in this window: what it just set, else `row.tags` (on the merged view, the merged tags' ids). None on
 * the row of a machine that takes no tags from here (an older Inbox: its tags stay its own), so no tag lists it.
 */
export function rowTagsHere(row: Pick<InboxListRow, 'thread_id' | 'tags' | 'machine'>, machines: Pick<MachinesModel, 'self' | 'linked'>, patches: ReadonlyMap<string, readonly string[]>): readonly string[] {
  if (!takesTags(row.machine, machines)) return [];
  return patches.get(row.thread_id) ?? row.tags ?? [];
}

/**
 * Whether Add tag is offered on a thread: one this Inbox owns, or a linked machine's (its id claimed by that machine,
 * `owner`, or its row named for it) when that machine takes tags, as Add to Priority is offered.
 */
export function canTagThread(threadId: string, rows: readonly Pick<InboxListRow, 'thread_id' | 'machine'>[], machines: Pick<MachinesModel, 'self' | 'linked'>, owner: string | null): boolean {
  return takesTags(owner ?? rows.find((r) => r.thread_id === threadId)?.machine, machines);
}

/** The tag a list route names (`#tag=ini_…`): by its id, or by its id on any machine (the merged id can move to this Inbox's). */
export function tagById<T extends ListTag>(tags: readonly T[], id: string): T | null {
  return tags.find((tag) => tag.id === id) ?? tags.find((tag) => Object.values(tag.machines ?? {}).includes(id)) ?? null;
}

/** The tag's id on `machine` (null or `self`: this Inbox), or null when that machine holds no tag of its name. */
export function tagIdOn(tag: ListTag, machine: string | null, self: string | null): string | null {
  const on = machine ?? self;
  if (!tag.machines) return on === self ? tag.id : null;
  return on ? (tag.machines[on] ?? null) : null;
}

/**
 * What a tag write names on the thread's own machine: this Inbox's id for its own thread, else the tag's name, which
 * that machine matches by the same rule and makes when it has none (an id kept from its list may be gone there).
 */
export function tagWrite(tag: ListTag, machine: string | null, self: string | null): { tag: string } | { name: string } {
  const id = !machine || machine === self ? tagIdOn(tag, null, self) : null;
  return id ? { tag: id } : { name: tag.name };
}

/** This Inbox's own tags (the `#` picker's: a typed `#Name` tags only by a tag this Inbox holds). */
export function thisInboxTags<T extends ListTag>(tags: readonly T[], self: string | null): T[] {
  return tags.filter((tag) => tagIdOn(tag, null, self) !== null);
}

/** The sections with only the rows in `tag` (each section kept, as a project's list keeps them). */
export function filterTagRows(sections: readonly InboxListSection[], tag: string | null, tagsOf: RowTags = ownTags): InboxListSection[] {
  if (!tag) return sections as InboxListSection[];
  return sections.map((section) => ({ ...section, threads: section.threads.filter((row) => tagsOf(row).includes(tag)) }));
}

/** Per tag, the threads in it that wait on the person (Stopped, Holding, Waiting): the Projects rule for the count. */
export function tagWaitingCounts(sections: readonly InboxListSection[], tagsOf: RowTags = ownTags): Map<string, number> {
  const counts = new Map<string, number>();
  for (const section of sections) {
    if (section.id !== 'stopped' && section.id !== 'holding' && section.id !== 'waiting') continue;
    for (const row of section.threads) for (const tag of tagsOf(row)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

/** Per tag, every listed thread in it (each once). */
export function tagThreadCounts(rows: readonly InboxListRow[], tagsOf: RowTags = ownTags): Map<string, number> {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (seen.has(row.thread_id)) continue;
    seen.add(row.thread_id);
    for (const tag of tagsOf(row)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether the sidebar draws Tags: once a live tag holds a thread the window lists, or the person made one (the
 * owner: no section until you tag something).
 */
export function tagsSectionShown(tags: readonly InboxInitiative[], rows: readonly InboxListRow[], tagsOf: RowTags = ownTags): boolean {
  if (tags.length === 0) return false;
  if (tags.some((tag) => tag.created_by?.kind === 'person')) return true;
  const live = new Set(tags.map((tag) => tag.id));
  return rows.some((row) => tagsOf(row).some((id) => live.has(id)));
}

/** "5 threads · 1 project": the tag's list header, from the rows it shows. */
export function tagListSummary(rows: readonly InboxListRow[]): string {
  const threads = new Set(rows.map((row) => row.thread_id));
  const projects = new Set(rows.map((row) => row.project.id));
  return `${plural(threads.size, 'thread')} · ${plural(projects.size, 'project')}`;
}

/** The tags a typed name keeps (case ignored): those whose name starts with it first, then those that hold it. */
export function findTags(tags: readonly InboxInitiative[], query: string): InboxInitiative[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...tags];
  const keyed = tags.map((tag) => ({ tag, name: tag.name.toLocaleLowerCase() }));
  return [...keyed.filter((x) => x.name.startsWith(q)), ...keyed.filter((x) => !x.name.startsWith(q) && x.name.includes(q))].map((x) => x.tag);
}

/** The live tag a typed name is (the store's rule: case and surrounding space ignored), or null: `New tag "…"` is offered. */
export function tagNamed(tags: readonly InboxInitiative[], name: string): InboxInitiative | null {
  const key = inboxInitiativeNameKey(name);
  return key ? (tags.find((tag) => inboxInitiativeNameKey(tag.name) === key) ?? null) : null;
}

/** A tag's sent link with the Board off: its list in the Inbox. */
export function tagHref(id: string): string {
  return `#tag=${encodeURIComponent(id)}`;
}
