/**
 * The open-file tabs beside a thread (approval "inbox-files-tabs"): an
 * ordered list of file ids (an attachment's `att_…`, a project file's
 * `pf:…`). The route says which one is on screen; these rules say where a
 * file lands and what shows when one closes:
 *
 * - A file opened on purpose gets a tab right of the one on screen, or its
 *   own tab when it already has one (`openTab`).
 * - `]` and `[` step inside the tab on screen: the tab now holds the next
 *   file (`stepTab`); a file already in another tab is not doubled.
 * - Closing the tab on screen shows the one to its right, else its left,
 *   else none: the Artifacts tab (`closeTab`).
 *
 * The tabs are kept per thread for the window's life (`threadTabs`), never
 * stored: a reload starts with the file in the address.
 */

export type FileTabs = readonly string[];

/** Open `id` on purpose: its own tab if it has one, else a new one right of `current` (at the end without one). */
export function openTab(tabs: FileTabs, id: string, current: string | null): FileTabs {
  if (tabs.includes(id)) return tabs;
  const at = current === null ? -1 : tabs.indexOf(current);
  if (at < 0) return [...tabs, id];
  return [...tabs.slice(0, at + 1), id, ...tabs.slice(at + 1)];
}

/** Step from `from` to `to` inside one tab (`]`, `[`): `to` takes `from`'s place, unless it has a tab already. */
export function stepTab(tabs: FileTabs, from: string | null, to: string): FileTabs {
  if (tabs.includes(to)) return tabs;
  const at = from === null ? -1 : tabs.indexOf(from);
  if (at < 0) return [...tabs, to];
  const next = [...tabs];
  next[at] = to;
  return next;
}

/** Close `id`: the tabs left, and what shows now (`current` unchanged unless it was the one closed; null is the Artifacts tab). */
export function closeTab(tabs: FileTabs, id: string, current: string | null): { tabs: FileTabs; current: string | null } {
  const at = tabs.indexOf(id);
  if (at < 0) return { tabs, current };
  const left = [...tabs.slice(0, at), ...tabs.slice(at + 1)];
  if (current !== id) return { tabs: left, current };
  return { tabs: left, current: left[at] ?? left[at - 1] ?? null };
}

/** Close every tab but `keep` (the open-files menu's "Close the others"). */
export function closeOtherTabs(tabs: FileTabs, keep: string | null): FileTabs {
  return keep !== null && tabs.includes(keep) ? [keep] : [];
}

/** Drop tabs whose file is gone from the thread (a project file is never dropped here: it may come back). */
export function keepKnownTabs(tabs: FileTabs, known: (id: string) => boolean): FileTabs {
  const next = tabs.filter(known);
  return next.length === tabs.length ? tabs : next;
}

const memory = new Map<string, FileTabs>();

/** The tabs a thread had open when it was last on screen, for this window's life. */
export const threadTabs = {
  get(threadId: string): FileTabs {
    return memory.get(threadId) ?? [];
  },
  set(threadId: string, tabs: FileTabs): void {
    if (tabs.length === 0) memory.delete(threadId);
    else memory.set(threadId, tabs);
  },
  /** Tests only. */
  clear(): void {
    memory.clear();
  },
};
