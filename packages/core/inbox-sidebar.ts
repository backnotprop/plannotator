/**
 * The Inbox sidebar's layout (approval "inbox-sidebar-customize", 2026-11-08): which items show, their order, and
 * whether each sits in the top stack or the bottom one. One layout per person, saved in config.json `inboxSidebar`
 * and shared by every window, the phone's included.
 *
 * The registry below is the one list of items. A new sidebar row (a future Artifacts row, say) is one more entry:
 * its place in the default layout, whether it hides, and its words. Starred, Machines and Projects are not items:
 * they always sit between the two stacks and scroll. The notices (Update, What's new, Can't check, Reload agents)
 * are not items either.
 *
 * Pure functions only, shared by the window and the server.
 */

/**
 * Where an item lives:
 * - `brand`: the logo row, always first at the top. It hides; it does not move.
 * - `stack`: a row in the top or bottom stack. It moves, and hides unless it is locked.
 * - `settings-row`: an icon button on the Settings row. It hides; it rides with Settings.
 */
export type InboxSidebarPlace = 'brand' | 'stack' | 'settings-row';
export type InboxSidebarStack = 'top' | 'bottom';

export interface InboxSidebarItemSpec {
  id: string;
  /** The item's name in the right-click menu and the Customize panel. */
  label: string;
  place: InboxSidebarPlace;
  /** Where a `stack` item sits in the default layout. */
  stack?: InboxSidebarStack;
  /** False for Inbox (the way home) and Settings (the way back to everything, this panel included). */
  hideable: boolean;
}

/** Every item, in the default order: the top stack's, then the bottom's. */
export const INBOX_SIDEBAR_ITEMS = [
  { id: 'logo', label: 'Logo', place: 'brand', hideable: true },
  { id: 'search', label: 'Search', place: 'stack', stack: 'top', hideable: true },
  { id: 'new-message', label: 'New message', place: 'stack', stack: 'top', hideable: true },
  { id: 'inbox', label: 'Inbox', place: 'stack', stack: 'top', hideable: false },
  { id: 'board', label: 'Board', place: 'stack', stack: 'top', hideable: true },
  { id: 'shape', label: 'Shape', place: 'stack', stack: 'top', hideable: true },
  { id: 'reviews', label: 'Reviews', place: 'stack', stack: 'top', hideable: true },
  { id: 'drafts', label: 'Drafts', place: 'stack', stack: 'top', hideable: true },
  { id: 'copy-prompt', label: 'Copy prompt', place: 'stack', stack: 'bottom', hideable: true },
  { id: 'feedback', label: 'Feedback', place: 'stack', stack: 'bottom', hideable: true },
  { id: 'usage', label: 'Usage', place: 'stack', stack: 'bottom', hideable: true },
  { id: 'settings', label: 'Settings', place: 'stack', stack: 'bottom', hideable: false },
  { id: 'shortcuts', label: 'Keyboard shortcuts', place: 'settings-row', hideable: true },
  { id: 'theme', label: 'Light and dark', place: 'settings-row', hideable: true },
] as const satisfies readonly InboxSidebarItemSpec[];

export type InboxSidebarItem = (typeof INBOX_SIDEBAR_ITEMS)[number]['id'];

export interface InboxSidebarLayout {
  /** The top stack's items, in order (stack items only). */
  top: InboxSidebarItem[];
  /** The bottom stack's items, in order (stack items only). */
  bottom: InboxSidebarItem[];
  /** The hidden items, in registry order (never Inbox or Settings). */
  hidden: InboxSidebarItem[];
}

const SPECS: ReadonlyMap<string, InboxSidebarItemSpec> = new Map(INBOX_SIDEBAR_ITEMS.map((spec) => [spec.id, spec]));
const IDS = INBOX_SIDEBAR_ITEMS.map((spec) => spec.id) as InboxSidebarItem[];

export function inboxSidebarSpec(id: InboxSidebarItem): InboxSidebarItemSpec {
  return SPECS.get(id)!;
}
export const isInboxSidebarItem = (value: unknown): value is InboxSidebarItem => typeof value === 'string' && SPECS.has(value);
const isStackItem = (id: string): id is InboxSidebarItem => SPECS.get(id)?.place === 'stack';
export const inboxSidebarHideable = (id: InboxSidebarItem): boolean => SPECS.get(id)?.hideable === true;
export const inboxSidebarMovable = (id: InboxSidebarItem): boolean => SPECS.get(id)?.place === 'stack';

/** Today's sidebar, unchanged. */
export const INBOX_SIDEBAR_DEFAULT: InboxSidebarLayout = Object.freeze({
  top: INBOX_SIDEBAR_ITEMS.filter((spec) => spec.place === 'stack' && spec.stack === 'top').map((spec) => spec.id),
  bottom: INBOX_SIDEBAR_ITEMS.filter((spec) => spec.place === 'stack' && spec.stack === 'bottom').map((spec) => spec.id),
  hidden: [],
}) as InboxSidebarLayout;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/**
 * A saved layout, read leniently: a name this build does not know (a newer build's item, a hand edit) is dropped, a
 * repeated one counts once, a locked item is never hidden, and an item the layout does not name (one this build
 * added) takes its default place: after the item before it by default, if that is in the same stack. Null when
 * nothing was saved (not an object).
 */
export function inboxSidebarRead(value: unknown): InboxSidebarLayout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const seen = new Set<string>();
  const keep = (list: string[]) => list.filter((id): id is InboxSidebarItem => isStackItem(id) && !seen.has(id) && Boolean(seen.add(id)));
  const top = keep(strings(raw.top));
  const bottom = keep(strings(raw.bottom));
  for (const id of IDS) {
    if (!isStackItem(id) || seen.has(id)) continue;
    const stack = SPECS.get(id)!.stack!;
    const defaults = stack === 'top' ? INBOX_SIDEBAR_DEFAULT.top : INBOX_SIDEBAR_DEFAULT.bottom;
    const into = stack === 'top' ? top : bottom;
    const at = defaults.indexOf(id);
    const before = defaults.slice(0, at).reverse().find((other) => into.includes(other));
    const after = defaults.slice(at + 1).find((other) => into.includes(other));
    if (before) into.splice(into.indexOf(before) + 1, 0, id);
    else if (after) into.splice(into.indexOf(after), 0, id);
    else into.push(id);
    seen.add(id);
  }
  const named = new Set(strings(raw.hidden));
  const hidden = IDS.filter((id) => named.has(id) && inboxSidebarHideable(id));
  return { top, bottom, hidden };
}

/** At most this many names in a saved list: a stack holds every item at most once. */
const MAX_NAMES = 64;

/**
 * A layout sent to be saved, read strictly: `{ top, bottom, hidden }`, each a list of item names this build knows.
 * Null for anything else (the server answers `422`). Then read as `inboxSidebarRead` reads it.
 */
export function inboxSidebarCheck(value: unknown): InboxSidebarLayout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'top' && key !== 'bottom' && key !== 'hidden')) return null;
  for (const key of ['top', 'bottom', 'hidden'] as const) {
    const list = raw[key];
    if (!Array.isArray(list) || list.length > MAX_NAMES || !list.every(isInboxSidebarItem)) return null;
  }
  return inboxSidebarRead(raw);
}

export function inboxSidebarSame(a: InboxSidebarLayout, b: InboxSidebarLayout): boolean {
  const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return same(a.top, b.top) && same(a.bottom, b.bottom) && same(a.hidden, b.hidden);
}

export const inboxSidebarShown = (layout: InboxSidebarLayout, id: InboxSidebarItem): boolean => !layout.hidden.includes(id);
export const inboxSidebarStackOf = (layout: InboxSidebarLayout, id: InboxSidebarItem): InboxSidebarStack => (layout.bottom.includes(id) ? 'bottom' : 'top');

/** Shows or hides an item. Inbox and Settings never hide: the layout comes back unchanged. */
export function inboxSidebarSetShown(layout: InboxSidebarLayout, id: InboxSidebarItem, shown: boolean): InboxSidebarLayout {
  if (!inboxSidebarHideable(id) || inboxSidebarShown(layout, id) === shown) return layout;
  const hidden = new Set(layout.hidden);
  if (shown) hidden.delete(id);
  else hidden.add(id);
  return { ...layout, hidden: IDS.filter((item) => hidden.has(item)) };
}

/** Puts a stack item at `index` in `stack` (the end when past it), counted without the item itself. */
export function inboxSidebarMove(layout: InboxSidebarLayout, id: InboxSidebarItem, stack: InboxSidebarStack, index: number): InboxSidebarLayout {
  if (!inboxSidebarMovable(id)) return layout;
  const top = layout.top.filter((item) => item !== id);
  const bottom = layout.bottom.filter((item) => item !== id);
  const into = stack === 'top' ? top : bottom;
  into.splice(Math.max(0, Math.min(Math.trunc(index), into.length)), 0, id);
  return { ...layout, top, bottom };
}

/** Move to top (the end of the top stack) or Move to bottom (the start of the bottom stack): next to the scrolling lists. */
export function inboxSidebarToStack(layout: InboxSidebarLayout, id: InboxSidebarItem, stack: InboxSidebarStack): InboxSidebarLayout {
  if (inboxSidebarStackOf(layout, id) === stack) return layout;
  return inboxSidebarMove(layout, id, stack, stack === 'top' ? layout.top.length : 0);
}

/**
 * Move up or Move down within the item's stack, past the next item this Inbox draws (`drawn`: Board with the Board
 * off is skipped, and keeps its place). At the end of its stack nothing changes: Move to top / bottom crosses.
 */
export function inboxSidebarStep(layout: InboxSidebarLayout, id: InboxSidebarItem, by: -1 | 1, drawn: (id: InboxSidebarItem) => boolean = () => true): InboxSidebarLayout {
  if (!inboxSidebarMovable(id)) return layout;
  const stack = inboxSidebarStackOf(layout, id);
  const full = stack === 'top' ? layout.top : layout.bottom;
  const visible = full.filter((item) => item === id || drawn(item));
  const next = visible[visible.indexOf(id) + by];
  if (!next) return layout;
  const without = full.filter((item) => item !== id);
  const at = without.indexOf(next);
  return inboxSidebarMove(layout, id, stack, by > 0 ? at + 1 : at);
}

/** Whether Move up / Move down has somewhere to go (see `inboxSidebarStep`). */
export function inboxSidebarCanStep(layout: InboxSidebarLayout, id: InboxSidebarItem, by: -1 | 1, drawn: (id: InboxSidebarItem) => boolean = () => true): boolean {
  return !inboxSidebarSame(inboxSidebarStep(layout, id, by, drawn), layout);
}

export type InboxSidebarPreset = 'default' | 'all-top' | 'minimal';

/** The Customize panel's "Start from" choices. Minimal hides what a person who knows the Inbox can do without. */
export const INBOX_SIDEBAR_PRESETS: Readonly<Record<InboxSidebarPreset, { label: string; layout: InboxSidebarLayout }>> = {
  default: { label: 'Default', layout: INBOX_SIDEBAR_DEFAULT },
  'all-top': { label: 'All at top', layout: { top: [...INBOX_SIDEBAR_DEFAULT.top, ...INBOX_SIDEBAR_DEFAULT.bottom], bottom: [], hidden: [] } },
  minimal: {
    label: 'Minimal',
    layout: { top: [...INBOX_SIDEBAR_DEFAULT.top], bottom: [...INBOX_SIDEBAR_DEFAULT.bottom], hidden: ['new-message', 'copy-prompt', 'feedback', 'usage', 'shortcuts'] },
  },
};
export const INBOX_SIDEBAR_PRESET_ORDER: readonly InboxSidebarPreset[] = ['default', 'all-top', 'minimal'];

/** The preset a layout is, or null ("Custom"). */
export function inboxSidebarPreset(layout: InboxSidebarLayout): InboxSidebarPreset | null {
  return INBOX_SIDEBAR_PRESET_ORDER.find((preset) => inboxSidebarSame(layout, INBOX_SIDEBAR_PRESETS[preset].layout)) ?? null;
}
