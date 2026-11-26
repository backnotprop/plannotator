/**
 * The list's filter in its header (the owner, 2026-11-08: "it needs to be the classic filter icon and nothing else in
 * the header under any state. A number badge can show and the filter icon can change color. That's all I want."; the
 * rule is listFilter.ts).
 *
 * - The header holds the filter icon (three lines narrowing) alone, at every width. With picks it takes the accent
 *   colour and a small count in its corner (`CountBadge`, the PRs button's size): one per ticked row. No tokens, no line over the list: what is picked is read in the menu.
 * - The menu (Base UI's: arrows, Home/End, type-ahead, Escape and Tab close, focus back to the funnel): first, alone,
 *   the row that opens Filter by typing (`TITLE_FILTER_LABEL`, the search mark, no count; it closes the menu and the
 *   field under the header takes focus: TitleFilter.tsx), then Not seen (one
 *   row: only the rows drawn bold) and Recent activity (one row, the cursor mark, not Updated's clock; no count and no
 *   tick: it closes the menu and turns on a view of the list, not a filter: listRecentView.ts), Updated (Today, Last 7 days, Last 30 days, Custom range…), Agent (several; only
 *   with two agents or more), Routine (Routine threads, Other threads; only while Routines are on and a routine's thread
 *   is in the list), Pull request (Open, Draft, Merged, Closed, Has a PR, No PR, several; only once a thread in the list has a PR), Tag (several, each
 *   with the `#` mark; only once a tag holds a thread in the list, never on a tag's own list), then Project last, since the
 *   sidebar already narrows by project (each project, several; only on the Inbox page and with two projects or
 *   more). Each row shows how many threads it would leave and a tick when picked, then "Clear filters". It stays open while picking. A phone draws it as the bottom
 *   sheet titled "Filter".
 * - Custom range… opens a small panel by the funnel: From, To, Apply.
 * - Long lists: an Agent, Tag or Project section of more than 8 rows gets its own find field under its heading and a
 *   list of about seven rows that scrolls inside the menu, its picks above that scroll (ListFilterSections.tsx, the
 *   rule listFilterSearch.ts). Typing narrows that section only. Nothing sits at the menu's top; a short section, and
 *   the menu's type-ahead, are as they always were. The menu keeps one width while a section has a field.
 * - Nothing matches: `ListFilterEmpty` in the list's body, "No threads match" and Clear filters.
 *
 * No shortcut of its own.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { HostMark, Icon } from '../icons';
import { Tip } from './Tip';
import { RefMarkIcon } from '../board/RefMark';
import { TagIcon } from './InitiativePeek';
import { CountBadge } from './CountBadge';
import { useThreadTags } from '../threadTags';
import { toggledTagPick, withLiveTagPicks } from '../listFilterTags';
import { useRoutineThreads } from '../listFilterRoutines';
import { showRecentView } from '../listRecentView';
import { sectionIsLong } from '../listFilterSearch';
import { TITLE_FILTER_LABEL, filterRowsByTitle } from '../listTitleFilter';
import { openTitleFilter, useTitleFilterTextWhen } from '../listTitleFilterStore';
import { noteTravelFrom } from './titleFilterMotion';
import { FilterMenuRows, rowKeyToField, type FilterSection } from './ListFilterSections';
export { useTitleFilterList } from './TitleFilter';
export { RecentViewBar, RecentViewSaid } from './RecentViewBar';
import {
  NO_LIST_FILTER,
  PULL_OPTIONS,
  ROUTINE_OPTIONS,
  UPDATED_OPTIONS,
  rowNotSeen,
  rowPullMatches,
  rowPullStates,
  type PullPick,
  type RoutinePick,
  agentHost,
  appliedFilter,
  countWhere,
  localDay,
  pickCount,
  rowAgentNames,
  toggled,
  updatedSpan,
  type ListFilter,
  type UpdatedPick,
} from '../listFilter';

/** The header's icon: three lines narrowing (Lucide's `list-filter`, ISC; the owner's pick on #2921, 2026-11-08). */
function FilterGlyph({ size }: { size: number }) {
  return (
    <svg className="ib-ic" viewBox="0 0 24 24" style={{ width: size, height: size }} aria-hidden="true" focusable="false">
      <path d="M3 6h18M7 12h10M10 18h4" />
    </svg>
  );
}

export interface ListFilterSource {
  /** The rows the list holds before the filter (its project, machine and away cuts applied): the menu's counts. */
  rows: readonly InboxListRow[];
  /** A project's page (the sidebar's project): no Project group, and its picks step aside. */
  scoped: boolean;
  /** The window's project names by id. */
  names: ReadonlyMap<string, string>;
  filter: ListFilter;
  onChange: (next: ListFilter) => void;
  /** Which list this is (the sidebar's view): Filter by typing's close puts back the scroll of this list only. */
  place?: string;
}

/** The same source, field by field: App hands a new object on every draw of the window. */
const sameSource = (a: ListFilterSource, b: ListFilterSource) => a.rows === b.rows && a.scoped === b.scoped && a.names === b.names && a.filter === b.filter && a.onChange === b.onChange && a.place === b.place;

function usePortal(anchor: RefObject<HTMLElement | null>) {
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(anchor.current?.closest<HTMLElement>('.pn-inbox') ?? null), [anchor]);
  return portal;
}

const DAY_WORDS = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
/** A range in words: "Oct 20 – Nov 1". */
export function rangeWords(range: { from: string; to: string }): string {
  const [a, b] = range.from <= range.to ? [range.from, range.to] : [range.to, range.from];
  const at = (day: string) => {
    const [y, m, d] = day.split('-').map(Number);
    return DAY_WORDS.format(new Date(y!, m! - 1, d!));
  };
  return a === b ? at(a) : `${at(a)} – ${at(b)}`;
}

/**
 * Memoized on the source's fields (`sameSource`): typing in Filter by typing's field redraws the list, and a draw of
 * the window that changes none of them hands an equal source, so the menu's counts are not worked out again. While the
 * menu is open they count what the typed words leave.
 */
export const ListFilterButton = memo(function ListFilterButton({ source, phone }: { source: ListFilterSource; phone: boolean }) {
  const { rows, scoped, names, onChange } = source;
  const [open, setOpen] = useState(false);
  // The rows the counts read: those the typed words leave. The choices offered stay those of every row, so narrowing
  // by title never takes away a group whose pick is on.
  const typed = useTitleFilterTextWhen(open);
  const counted = useMemo(() => filterRowsByTitle(rows, typed), [rows, typed]);
  // Tags (approval "inbox-thread-tags", step 2): the window's, read with the rows' own rule (`rowTags`).
  const host = useThreadTags();
  const tagScoped = !!host?.listed;
  // Routines: off, the Routine picks step aside; not read yet, they still count in the badge; the group shows once read.
  const routineThreads = useRoutineThreads();
  const isRoutine = routineThreads.state === 'ready' ? routineThreads.test : null;
  const filter = withLiveTagPicks(appliedFilter(source.filter, scoped, tagScoped, routineThreads.state !== 'off'), host?.tags ?? null);
  // A row's tags as the Tag group reads them: its own and its project's (projectTags.ts).
  const tagsOf = host?.filterTags ?? host?.rowTags;
  const routineTest = isRoutine ?? undefined;
  const countOf = (group: Parameters<typeof countWhere>[3], test: (row: InboxListRow) => boolean) => countWhere(counted, filter, now, group, test, tagsOf, routineTest);
  const [rangeOpen, setRangeOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Filter by typing's row: the menu closes and the field takes focus. Drawn and focused inside the click, so a phone
  // raises its keyboard; the menu's close then gives focus to the field, not back to the funnel.
  const toField = useRef(false);
  const fieldOf = () => trigger.current?.closest('.ib-listcol')?.querySelector<HTMLInputElement>('[data-title-filter-input]') ?? null;
  const openField = () => {
    toField.current = true;
    // The row flies to the field's place (titleFilterMotion.ts), from the menu or from a phone's sheet.
    const row = (portal ?? document).querySelector<HTMLElement>('[data-list-filter-menu] [data-list-filter-title]');
    noteTravelFrom(row);
    if (row) row.style.visibility = 'hidden';
    setOpen(false);
    const list = trigger.current?.closest('.ib-listcol')?.querySelector<HTMLElement>('.ib-lbody');
    flushSync(() => openTitleFilter(list?.scrollTop ?? 0, source.place ?? ''));
    fieldOf()?.focus({ preventScroll: true });
  };
  const finalFocus = useCallback(() => {
    if (!toField.current) return true;
    toField.current = false;
    return fieldOf() ?? true;
  }, []);
  // The funnel sits outside the menu (a detached trigger), so the menu can gain or lose its search without the funnel
  // being drawn again.
  const [handle] = useState(() => Menu.createHandle());
  const portal = usePortal(trigger);
  const now = Date.now();
  const count = pickCount(filter);

  // The projects offered: those in the list, then any picked one it no longer holds (so it can be unticked).
  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of rows) if (!seen.has(row.project.id)) seen.set(row.project.id, names.get(row.project.id) ?? row.project.name);
    for (const id of source.filter.projects) if (!seen.has(id)) seen.set(id, names.get(id) ?? 'Project');
    return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  }, [rows, names, source.filter.projects]);
  const agents = useMemo(() => {
    const seen = new Map<string, string | null>();
    for (const row of rows) for (const name of rowAgentNames(row)) if (!seen.has(name)) seen.set(name, agentHost(row, name));
    for (const name of source.filter.agents) if (!seen.has(name)) seen.set(name, null);
    return [...seen].map(([name, host]) => ({ name, host })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, source.filter.agents]);

  // The tags offered: those holding a thread in the list, and any picked one (so it can be unticked); oldest first.
  const tags = useMemo(() => {
    if (!host || tagScoped) return [];
    const held = new Set(rows.flatMap((row) => (tagsOf ?? ((r: InboxListRow) => r.tags ?? []))(row)));
    return host.tags.filter((tag) => held.has(tag.id) || filter.tags.includes(tag.id));
  }, [host, tagScoped, rows, tagsOf, filter.tags]);

  const showProjects = !scoped && projects.length > 1;
  const showAgents = agents.length > 1;
  const set = (next: Partial<ListFilter>) => onChange({ ...source.filter, ...next });
  const custom = filter.updated !== null && typeof filter.updated !== 'string' ? filter.updated : null;
  const name = count > 0 ? `Filter, ${count} active` : 'Filter';

  // Offered once a thread here has a PR, and while a pick of it is remembered (so it can be unticked).
  const pulls = source.filter.pulls.length > 0 || rows.some((row) => rowPullStates(row).length > 0);
  // Offered while Routines are on, once a routine's thread is in the list, and while a pick of it is remembered.
  const routines = isRoutine !== null && (source.filter.routines.length > 0 || rows.some(isRoutine));

  // The menu as data, in its order (the owner, 2026-11-08): what the sidebar cannot do first, Project last (the sidebar
  // has its own). Not seen first: what every row shows, bold or not. A long Agent, Tag or Project section
  // gets its own find field (`find`, ListFilterSections.tsx).
  const sections: FilterSection[] = [
    {
      // Filter by typing: alone, first; it opens something, as Custom range… does (no count, no tick).
      id: 'title',
      title: null,
      rows: [{ key: 'title', label: TITLE_FILTER_LABEL, on: false, count: null, onToggle: openField, mark: <Icon name="search" />, data: { 'data-list-filter-title': '' }, opens: TITLE_FILTER_LABEL.replace('…', '') }],
    },
    {
      id: 'notSeen',
      title: null,
      rows: [
        { key: 'notSeen', label: 'Not seen', on: filter.notSeen, count: countOf('notSeen', rowNotSeen), onToggle: () => set({ notSeen: !source.filter.notSeen }), mark: <Icon name="envelope" />, data: { 'data-list-filter-not-seen': '' } },
        // Recent activity: a view, not a pick (listRecentView.ts). It opens something, as Filter by typing does: no count, no tick.
        { key: 'recent', label: 'Recent activity', on: false, count: null, onToggle: () => { setOpen(false); showRecentView(source.place ?? ''); }, mark: <Icon name="clickHere" />, data: { 'data-list-filter-recent': '' }, opens: 'Recent activity' },
      ],
    },
    {
      id: 'updated',
      title: 'Updated',
      rows: [
        ...UPDATED_OPTIONS.map((o) => ({
          key: o.value,
          label: o.label,
          on: filter.updated === o.value,
          count: countOf('updated', inSpan(o.value, now)),
          onToggle: () => set({ updated: filter.updated === o.value ? null : o.value }),
          mark: <Icon name="clock" />,
          data: { 'data-list-filter-updated': o.value },
        })),
        {
          key: 'range',
          label: custom ? rangeWords(custom) : 'Custom range…',
          on: custom !== null,
          count: custom ? countOf('updated', inSpan(custom, now)) : null,
          onToggle: () => {
            setOpen(false);
            requestAnimationFrame(() => setRangeOpen(true));
          },
          mark: <Icon name="clock" />,
          data: { 'data-list-filter-updated': 'range' },
          opens: 'Custom range',
        },
      ],
    },
    {
      id: 'agents',
      title: 'Agent',
      find: { words: 'Find an agent', none: (query) => `No agents match “${query}”` },
      rows: showAgents
        ? agents.map((a) => ({
            key: a.name,
            label: a.name,
            on: filter.agents.includes(a.name),
            count: countOf('agents', (row) => rowAgentNames(row).includes(a.name)),
            onToggle: () => set({ agents: toggled(source.filter.agents, a.name) }),
            mark: (
              <span className="ib-lflt-host" aria-hidden="true">
                <HostMark host={a.host} />
              </span>
            ),
            data: { 'data-list-filter-agent': a.name },
          }))
        : [],
    },
    {
      id: 'routines',
      title: 'Routine',
      rows: routines
        ? ROUTINE_OPTIONS.map((o) => ({
            key: o.value,
            label: o.label,
            on: filter.routines.includes(o.value),
            count: countOf('routines', (row) => !!isRoutine?.(row) === (o.value === 'routine')),
            onToggle: () => set({ routines: toggled(source.filter.routines, o.value) as RoutinePick[] }),
            mark: <Icon name={o.value === 'routine' ? 'scheduled' : 'minus'} />,
            data: { 'data-list-filter-routine': o.value },
          }))
        : [],
    },
    {
      id: 'pulls',
      title: 'Pull request',
      rows: pulls
        ? PULL_OPTIONS.map((o) => ({
            key: o.value,
            label: o.label,
            on: filter.pulls.includes(o.value),
            count: countOf('pulls', (row) => rowPullMatches(row, o.value)),
            onToggle: () => set({ pulls: toggled(source.filter.pulls, o.value) as PullPick[] }),
            mark: o.value === 'none' ? <Icon name="minus" /> : <RefMarkIcon kind="pr" state={o.value === 'any' ? 'unknown' : o.value} size={16} />,
            data: { 'data-list-filter-pull': o.value },
          }))
        : [],
    },
    {
      id: 'tags',
      title: 'Tag',
      find: { words: 'Find a tag', none: (query) => `No tags match “${query}”` },
      rows: tags.map((tag) => ({
        key: tag.id,
        label: tag.name,
        on: filter.tags.includes(tag.id),
        count: countOf('tags', (row) => (tagsOf ? tagsOf(row) : (row.tags ?? [])).includes(tag.id)),
        onToggle: () => set({ tags: toggledTagPick(source.filter.tags, tag, host?.tags ?? []) }),
        mark: <TagIcon className="ib-ic" />,
        data: { 'data-list-filter-tag': tag.id },
      })),
    },
    {
      id: 'projects',
      title: 'Project',
      find: { words: 'Find a project', none: (query) => `No projects match “${query}”` },
      rows: showProjects
        ? projects.map((p) => ({
            key: p.id,
            label: p.name,
            on: filter.projects.includes(p.id),
            count: countOf('projects', (row) => row.project.id === p.id),
            onToggle: () => set({ projects: toggled(source.filter.projects, p.id) }),
            mark: <Icon name="folder" />,
            data: { 'data-list-filter-project': p.id },
          }))
        : [],
    },
  ];

  // The sections drawn long (their own field and scroll); fixed while the menu is open, so a list that changes under
  // an open menu never swaps a section's look out from under the person.
  const longNow = sections
    .filter((s) => s.find && sectionIsLong(s.rows.length))
    .map((s) => s.id)
    .join(' ');
  const [longIds, setLongIds] = useState(longNow);
  if (!open && longIds !== longNow) setLongIds(longNow);
  const clear = count > 0 ? () => onChange(clearedFrom(source.filter, scoped, tagScoped)) : null;

  return (
    <>
      <Tip content={count > 0 ? `Filter · ${count} active` : 'Filter'}>
        <Menu.Trigger handle={handle} ref={trigger} className="ib-lflt" aria-label={name} data-set={count > 0 ? '' : undefined} data-list-filter="">
          <span className="ib-lflt-g ib-cnt-host">
            <FilterGlyph size={phone ? 20 : 16} />
            {count > 0 && <CountBadge count={count} data={{ 'data-list-filter-count': '' }} />}
          </span>
        </Menu.Trigger>
      </Tip>
      <FilterMenu handle={handle} open={open} onOpenChange={setOpen} phone={phone} portal={portal} longIds={longIds} sections={sections} onClear={clear} finalFocus={finalFocus} />
      <RangePanel key={rangeOpen ? 'open' : 'shut'} open={rangeOpen} onOpenChange={setRangeOpen} anchor={trigger} portal={portal} phone={phone} start={custom} onApply={(range) => set({ updated: range })} />
    </>
  );
}, (a, b) => a.phone === b.phone && sameSource(a.source, b.source));

/**
 * The menu itself. Its rows (ListFilterSections.tsx) are drawn only while it is open, and the words typed in a long
 * section's field live there, so typing redraws only the menu: the rows and their counts are worked out by
 * `ListFilterButton`, which typing does not redraw.
 */
function FilterMenu({
  handle,
  open,
  onOpenChange,
  phone,
  portal,
  longIds,
  sections,
  onClear,
  finalFocus,
}: {
  handle: ReturnType<typeof Menu.createHandle>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phone: boolean;
  portal: HTMLElement | null;
  /** The long sections' ids, space-separated (fixed while the menu is open). */
  longIds: string;
  sections: readonly FilterSection[];
  /** Clear filters; null: nothing is picked, no row. */
  onClear: (() => void) | null;
  /** Where focus goes as the menu closes: the funnel, or Filter by typing's field after its row. */
  finalFocus: () => true | HTMLElement;
}) {
  const long = useMemo(() => new Set(longIds.split(' ').filter(Boolean)), [longIds]);
  const fields = long.size > 0 ? '' : undefined;
  // A field has focus: the pointer only hovers rows then (Base UI's hover would move focus from the field to the row).
  const [typing, setTyping] = useState(false);
  if (!open && typing) setTyping(false);
  const popup = useRef<HTMLDivElement>(null);
  // Base UI puts focus on the popup's first tabbable element as it opens. After a click or a tap no row is tabbable
  // yet, so that was a long section's field (its line drawn as focused, the pointer's hover off, a phone's keyboard
  // rising): the popup itself takes focus instead, as in a menu with no field. Any other open (Enter, Space, ↓, which
  // Base UI may report as '') is Base UI's as always: its highlighted first row.
  const POINTER_OPENS = ['mouse', 'touch', 'pen'];
  const initialFocus = { initialFocus: (type: string) => (POINTER_OPENS.includes(type) ? (popup.current ?? true) : true) };

  return (
    <Menu.Root handle={handle} open={open} onOpenChange={onOpenChange} modal={phone} highlightItemOnHover={!typing}>
      <Menu.Portal container={portal ?? undefined}>
        {phone && <Menu.Backdrop className="ib-pm-scrim" />}
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={6} data-phone={phone ? '' : undefined} data-list-filter-fields={fields}>
          <Menu.Popup
            ref={popup}
            // `initialFocus` is absent from Base UI 1.9.0's public types (MenuPopup still passes it on); if an upgrade
            // drops it, tests/e2e/inbox-filter-section-fields.spec.ts fails (a click open focusing a field).
            {...initialFocus}
            className="ib-pm ib-pc-menu ib-lflt-menu"
            aria-label="Filter"
            finalFocus={finalFocus}
            onKeyDown={rowKeyToField}
            data-list-filter-menu=""
            data-list-filter-fields={fields}
            data-list-filter-typing={typing ? '' : undefined}
          >
            <div className="ib-pm-title" aria-hidden="true">
              Filter
            </div>
            <FilterMenuRows sections={sections} long={long} onClear={onClear} phone={phone} onTyping={setTyping} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const inSpan = (pick: UpdatedPick, now: number) => {
  const [from, to] = updatedSpan(pick, now);
  return (row: InboxListRow) => {
    const at = Date.parse(row.last_at);
    return at >= from && at < to;
  };
};

/**
 * Clear filters: every pick that applies here. On a project's page that is all but the Project picks, on a tag's
 * list all but the Tag picks: they stepped aside there and come back on Inbox.
 */
export function clearedFrom(filter: ListFilter, scoped: boolean, tagScoped = false): ListFilter {
  if (!scoped && !tagScoped) return NO_LIST_FILTER;
  return { ...NO_LIST_FILTER, ...(scoped ? { projects: filter.projects } : {}), ...(tagScoped ? { tags: filter.tags } : {}) };
}

function RangePanel({
  open,
  onOpenChange,
  anchor,
  portal,
  phone,
  start,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: RefObject<HTMLButtonElement | null>;
  portal: HTMLElement | null;
  phone: boolean;
  start: { from: string; to: string } | null;
  onApply: (range: { from: string; to: string }) => void;
}) {
  const today = localDay(Date.now());
  const [from, setFrom] = useState(start?.from ?? localDay(Date.now() - 13 * 86_400_000));
  const [to, setTo] = useState(start?.to ?? today);
  const ok = !!from && !!to;
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange} modal={phone}>
      <Popover.Portal container={portal ?? undefined}>
        {phone && <Popover.Backdrop className="ib-pm-scrim" />}
        <Popover.Positioner className="ib-tidy-pos" anchor={anchor} side="bottom" align="end" sideOffset={6} data-phone={phone ? '' : undefined}>
          <Popover.Popup className="ib-tidy ib-lflt-range" aria-label="Custom range" finalFocus={anchor} data-list-filter-range="">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!ok) return;
                onApply(from <= to ? { from, to } : { from: to, to: from });
                onOpenChange(false);
              }}
            >
              <div className="ib-lflt-range-h">Updated between</div>
              <div className="ib-lflt-range-days">
                <label>
                  <span>From</span>
                  <input type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} required data-list-filter-from="" />
                </label>
                <label>
                  <span>To</span>
                  <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} required data-list-filter-to="" />
                </label>
              </div>
              <div className="ib-lflt-range-act">
                <button type="button" className="ib-btn ib-ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </button>
                <button type="submit" className="ib-btn ib-pri" disabled={!ok} data-list-filter-apply="">
                  Apply
                </button>
              </div>
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Nothing the filter keeps: in the list's body, never the header. Clear filters puts focus back on the funnel. */
export function ListFilterEmpty({ onClear }: { onClear: () => void }) {
  return (
    <div className="ib-empty-list ib-lflt-empty" data-list-filter-empty="">
      <b>No threads match</b>
      <button
        type="button"
        className="ib-btn"
        onClick={(event) => {
          const column = event.currentTarget.closest('.ib-listcol');
          onClear();
          requestAnimationFrame(() => column?.querySelector<HTMLElement>('[data-list-filter]')?.focus());
        }}
        data-list-filter-empty-clear=""
      >
        Clear filters
      </button>
    </div>
  );
}

/** Recent activity's view (listRecentView.ts) with no thread to show: one line in the list's own empty style. */
export function RecentViewEmpty() {
  return (
    <div className="ib-empty-list" data-recent-view-empty="">
      Nothing you acted in during the last month.
    </div>
  );
}
