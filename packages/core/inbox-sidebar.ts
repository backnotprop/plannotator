export type InboxSidebarPlace = 'brand' | 'stack' | 'settings-row' | 'middle';
export type InboxSidebarStack = 'top' | 'bottom';

export interface InboxSidebarItemSpec {
  id: string;
  label: string;
  place: InboxSidebarPlace;
  stack?: InboxSidebarStack;
  hideable: boolean;
}

export const INBOX_SIDEBAR_ITEMS = [
  { id: 'logo', label: 'Logo', place: 'brand', hideable: true },
  { id: 'search', label: 'Search', place: 'stack', stack: 'top', hideable: true },
  { id: 'new-message', label: 'New message', place: 'stack', stack: 'top', hideable: true },
  { id: 'inbox', label: 'Inbox', place: 'stack', stack: 'top', hideable: false },
  { id: 'board', label: 'Board', place: 'stack', stack: 'top', hideable: true },
  { id: 'shape', label: 'Shape', place: 'stack', stack: 'top', hideable: true },
  { id: 'artifacts', label: 'Artifacts', place: 'stack', stack: 'top', hideable: true },
  { id: 'reviews', label: 'Reviews', place: 'stack', stack: 'top', hideable: true },
  { id: 'drafts', label: 'Drafts', place: 'stack', stack: 'top', hideable: true },
  { id: 'agents', label: 'Agents', place: 'middle', hideable: true },
  { id: 'copy-prompt', label: 'Copy prompt', place: 'stack', stack: 'bottom', hideable: true },
  { id: 'feedback', label: 'Feedback', place: 'stack', stack: 'bottom', hideable: true },
  { id: 'usage', label: 'Usage', place: 'stack', stack: 'bottom', hideable: true },
  { id: 'settings', label: 'Settings', place: 'stack', stack: 'bottom', hideable: false },
  { id: 'shortcuts', label: 'Keyboard shortcuts', place: 'settings-row', hideable: true },
  { id: 'theme', label: 'Light and dark', place: 'settings-row', hideable: true },
] as const satisfies readonly InboxSidebarItemSpec[];

export type InboxSidebarItem = (typeof INBOX_SIDEBAR_ITEMS)[number]['id'];

export interface InboxSidebarLayout {
  top: InboxSidebarItem[];
  bottom: InboxSidebarItem[];
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

export const INBOX_SIDEBAR_DEFAULT: InboxSidebarLayout = Object.freeze({
  top: INBOX_SIDEBAR_ITEMS.filter((spec) => spec.place === 'stack' && spec.stack === 'top').map((spec) => spec.id),
  bottom: INBOX_SIDEBAR_ITEMS.filter((spec) => spec.place === 'stack' && spec.stack === 'bottom').map((spec) => spec.id),
  hidden: [],
}) as InboxSidebarLayout;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

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

const MAX_NAMES = 64;

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

export function inboxSidebarSetShown(layout: InboxSidebarLayout, id: InboxSidebarItem, shown: boolean): InboxSidebarLayout {
  if (!inboxSidebarHideable(id) || inboxSidebarShown(layout, id) === shown) return layout;
  const hidden = new Set(layout.hidden);
  if (shown) hidden.delete(id);
  else hidden.add(id);
  return { ...layout, hidden: IDS.filter((item) => hidden.has(item)) };
}

export function inboxSidebarMove(layout: InboxSidebarLayout, id: InboxSidebarItem, stack: InboxSidebarStack, index: number): InboxSidebarLayout {
  if (!inboxSidebarMovable(id)) return layout;
  const top = layout.top.filter((item) => item !== id);
  const bottom = layout.bottom.filter((item) => item !== id);
  const into = stack === 'top' ? top : bottom;
  into.splice(Math.max(0, Math.min(Math.trunc(index), into.length)), 0, id);
  return { ...layout, top, bottom };
}

export function inboxSidebarToStack(layout: InboxSidebarLayout, id: InboxSidebarItem, stack: InboxSidebarStack): InboxSidebarLayout {
  if (inboxSidebarStackOf(layout, id) === stack) return layout;
  return inboxSidebarMove(layout, id, stack, stack === 'top' ? layout.top.length : 0);
}

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

export function inboxSidebarCanStep(layout: InboxSidebarLayout, id: InboxSidebarItem, by: -1 | 1, drawn: (id: InboxSidebarItem) => boolean = () => true): boolean {
  return !inboxSidebarSame(inboxSidebarStep(layout, id, by, drawn), layout);
}

export type InboxSidebarPreset = 'default' | 'all-top' | 'minimal';

export const INBOX_SIDEBAR_PRESETS: Readonly<Record<InboxSidebarPreset, { label: string; layout: InboxSidebarLayout }>> = {
  default: { label: 'Default', layout: INBOX_SIDEBAR_DEFAULT },
  'all-top': { label: 'All at top', layout: { top: [...INBOX_SIDEBAR_DEFAULT.top, ...INBOX_SIDEBAR_DEFAULT.bottom], bottom: [], hidden: [] } },
  minimal: {
    label: 'Minimal',
    layout: { top: [...INBOX_SIDEBAR_DEFAULT.top], bottom: [...INBOX_SIDEBAR_DEFAULT.bottom], hidden: ['new-message', 'copy-prompt', 'feedback', 'usage', 'shortcuts'] },
  },
};
export const INBOX_SIDEBAR_PRESET_ORDER: readonly InboxSidebarPreset[] = ['default', 'all-top', 'minimal'];

export function inboxSidebarPreset(layout: InboxSidebarLayout): InboxSidebarPreset | null {
  return INBOX_SIDEBAR_PRESET_ORDER.find((preset) => inboxSidebarSame(layout, INBOX_SIDEBAR_PRESETS[preset].layout)) ?? null;
}
