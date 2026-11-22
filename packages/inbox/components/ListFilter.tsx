/**
 * The list's filter in its header (the owner, 2026-11-08: "it needs to be the classic filter icon and nothing else in
 * the header under any state. A number badge can show and the filter icon can change color. That's all I want."; the
 * rule is listFilter.ts).
 *
 * - The header holds the filter icon (three lines narrowing) alone, at every width. With picks it takes the accent
 *   colour and a small count in its corner (`CountBadge`, the PRs button's size): one per ticked row. No tokens, no line over the list: what is picked is read in the menu.
 * - The menu (Base UI's: arrows, Home/End, type-ahead, Escape and Tab close, focus back to the funnel): Not seen (one
 *   row: only the rows drawn bold) and Recent activity (one row, the cursor mark, not Updated's clock: the threads the
 *   person did something in lately, newest first by that; listFilterRecent.ts), Updated (Today, Last 7 days, Last 30 days, Custom range…), Agent (several; only
 *   with two agents or more), Routine (Routine threads, Other threads; only while Routines are on and a routine's thread
 *   is in the list), Pull request (Open, Draft, Merged, Closed, Has a PR, No PR, several; only once a thread in the list has a PR), Tag (several, each
 *   with the `#` mark; only once a tag holds a thread in the list, never on a tag's own list), then Project last, since the
 *   sidebar already narrows by project (each project, several; only on the Inbox page and with two projects or
 *   more). Each row shows how many threads it would leave and a tick when picked, then "Clear filters". It stays open while picking. A phone draws it as the bottom
 *   sheet titled "Filter".
 * - Custom range… opens a small panel by the funnel: From, To, Apply.
 * - Long lists (a section of more than 8 rows, listFilterSearch.ts): one field at the top, "Search filters".
 *   Typing narrows every section at once (the match bold, a ticked row kept, a section with nothing left gone,
 *   "Nothing matches “…”" when no row matches); the menu keeps its one scroll. Base UI's filterable menu
 *   (`Menu.FilterProvider`, `Menu.Input`, `Menu.List`): the field keeps focus while ↑ ↓ move the highlight
 *   (`aria-activedescendant`, wrapping as the plain menu does), Enter ticks or unticks the highlighted row, Space types
 *   a space, Escape empties the field first and then closes. With the field empty Home and End go to the first and
 *   last row; with text in it they move the caret. Tab moves focus out of the menu, which closes it. With nothing
 *   matching no row is highlighted, and Enter does nothing until an arrow picks a row. A touch or pen open leaves the
 *   field unfocused, so a phone's keyboard stays down; the phone's sheet then sits on the keyboard (inbox.css). The
 *   menu keeps one width while typing. With short lists none of this: the plain menu, its type-ahead included.
 * - Nothing matches: `ListFilterEmpty` in the list's body, "No threads match" and Clear filters.
 *
 * No shortcut of its own.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { formatCount } from '../format';
import { HostMark, Icon } from '../icons';
import { Tip } from './Tip';
import { RefMarkIcon } from '../board/RefMark';
import { TagIcon } from './InitiativePeek';
import { CountBadge } from './CountBadge';
import { useThreadTags } from '../threadTags';
import { toggledTagPick, withLiveTagPicks } from '../listFilterTags';
import { useRoutineThreads } from '../listFilterRoutines';
import { rowRecentlyActed } from '../listFilterRecent';
import { filterSearchShown, labelStart, searchFilterSections, type FilterSearchRow } from '../listFilterSearch';
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
}

function usePortal(anchor: RefObject<HTMLElement | null>) {
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(anchor.current?.closest<HTMLElement>('.pn-inbox') ?? null), [anchor]);
  return portal;
}

const tick = (on: boolean) => <span className="ib-pc-tick">{on && <Icon name="check" />}</span>;

/** The search's words (the field's placeholder and name; the line and the count a screen reader hears). */
const FIND_WORDS = 'Search filters';
/** The × in the field: its name, for a screen reader's touch or virtual cursor (Escape does the same from the keyboard).
 * Base UI hides its clear button from screen readers; `aria-hidden={false}` puts it back. */
const CLEAR_WORDS = 'Clear search';
const nothingMatches = (query: string) => `Nothing matches “${query}”`;
const matchWords = (n: number, query: string) => (n === 0 ? nothingMatches(query) : n === 1 ? '1 match' : `${formatCount(n)} matches`);

/** A row's label with the search's match drawn bold, from `labelStart` ("…" for what it drops). */
function lit(label: string, hit: readonly [number, number] | null) {
  if (!hit) return label;
  const from = labelStart(label, hit);
  return (
    <>
      {from > 0 && <span aria-hidden="true">…</span>}
      {label.slice(from, hit[0])}
      <b className="ib-lflt-hit">{label.slice(hit[0], hit[1])}</b>
      {label.slice(hit[1])}
    </>
  );
}

/** One row of the menu: a pick, or (`opens`, its Base UI label) the row that opens Custom range's panel. */
interface FilterRow {
  key: string;
  label: string;
  on: boolean;
  count: number | null;
  onToggle: () => void;
  mark: React.ReactNode;
  data: Record<string, string>;
  opens?: string;
}
interface FilterSection {
  id: string;
  /** Null: no group label (Not seen). */
  title: string | null;
  rows: FilterRow[];
}

function CheckRow({ label, hit, on, count, onToggle, mark, data }: { label: string; hit: readonly [number, number] | null; on: boolean; count: number; onToggle: () => void; mark: React.ReactNode; data: Record<string, string> }) {
  return (
    <Menu.CheckboxItem className="ib-pmi" label={label} aria-label={labelStart(label, hit) > 0 ? `${label} ${formatCount(count)}` : undefined} checked={on} onCheckedChange={onToggle} closeOnClick={false} {...data}>
      {mark}
      <span className="ib-pmi-l" dir="auto">
        {lit(label, hit)}
      </span>
      <span className="ib-pmi-n">{formatCount(count)}</span>
      {tick(on)}
    </Menu.CheckboxItem>
  );
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

export function ListFilterButton({ source, phone }: { source: ListFilterSource; phone: boolean }) {
  const { rows, scoped, names, onChange } = source;
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
  const countOf = (group: Parameters<typeof countWhere>[3], test: (row: InboxListRow) => boolean) => countWhere(rows, filter, now, group, test, tagsOf, routineTest);
  const [open, setOpen] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
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
  // has its own). Not seen first: what every row shows, bold or not. The search narrows these (listFilterSearch.ts).
  const sections: FilterSection[] = [
    {
      id: 'notSeen',
      title: null,
      rows: [
        { key: 'notSeen', label: 'Not seen', on: filter.notSeen, count: countOf('notSeen', rowNotSeen), onToggle: () => set({ notSeen: !source.filter.notSeen }), mark: <Icon name="envelope" />, data: { 'data-list-filter-not-seen': '' } },
        { key: 'recent', label: 'Recent activity', on: filter.recent, count: countOf('recent', (row) => rowRecentlyActed(row, now)), onToggle: () => set({ recent: !source.filter.recent }), mark: <Icon name="clickHere" />, data: { 'data-list-filter-recent': '' } },
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

  // The search shows only while a section is long; whether it shows is fixed while the menu is open, so a list that
  // changes under an open menu never swaps the menu out from under the person.
  const long = filterSearchShown(sections.map((s) => s.rows.length));
  const [searchable, setSearchable] = useState(long);
  if (!open && searchable !== long) setSearchable(long);
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
      <FilterMenu handle={handle} open={open} onOpenChange={setOpen} phone={phone} portal={portal} searchable={searchable} sections={sections} onClear={clear} />
      <RangePanel key={rangeOpen ? 'open' : 'shut'} open={rangeOpen} onOpenChange={setRangeOpen} anchor={trigger} portal={portal} phone={phone} start={custom} onApply={(range) => set({ updated: range })} />
    </>
  );
}

/** The keys that pick a row from the field while nothing matches (Home and End only move the caret then). */
const STEP_KEYS = new Set(['ArrowDown', 'ArrowUp']);

/** How long the match count waits for typing to pause before a screen reader hears it. */
const STATUS_WAIT_MS = 400;

/**
 * The menu itself. The search's query lives here, so typing redraws only the menu: the rows and their counts are worked
 * out by `ListFilterButton`, which typing does not redraw.
 */
function FilterMenu({
  handle,
  open,
  onOpenChange,
  phone,
  portal,
  searchable,
  sections,
  onClear,
}: {
  handle: ReturnType<typeof Menu.createHandle>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phone: boolean;
  portal: HTMLElement | null;
  searchable: boolean;
  sections: readonly FilterSection[];
  /** Clear filters; null: nothing is picked, no row. */
  onClear: (() => void) | null;
}) {
  const [query, setQuery] = useState('');
  /** An arrow moved the highlight since the query last changed. */
  const arrowed = useRef(false);
  const found = searchFilterSections<FilterSection, FilterRow>(sections, searchable ? query : '');
  const typed = query.trim();
  // The count a screen reader hears, once typing pauses (not on every key).
  const words = found.searching ? matchWords(found.matches, typed) : '';
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (words === '') {
      setSaid('');
      return;
    }
    const wait = setTimeout(() => setSaid(words), STATUS_WAIT_MS);
    return () => clearTimeout(wait);
  }, [words]);

  // While nothing matches, the rows still drawn (kept because they are ticked, and Clear filters) take new keys, so Base
  // UI sees new rows and drops a highlight left on one from the query before (it clears a highlight on a change only when
  // `autoHighlight` was already off).
  const keyOf = (row: FilterRow) => (found.searching && found.matches === 0 ? `${row.key}:kept` : row.key);
  const drawRow = ({ row, hit }: FilterSearchRow<FilterRow>) =>
    row.opens ? (
      <Menu.Item key={keyOf(row)} className="ib-pmi" label={row.opens} onClick={row.onToggle} data-checked={row.on ? '' : undefined} {...row.data}>
        {row.mark}
        <span className="ib-pmi-l">{lit(row.label, hit)}</span>
        {row.count !== null && <span className="ib-pmi-n">{formatCount(row.count)}</span>}
        {tick(row.on)}
      </Menu.Item>
    ) : (
      <CheckRow key={keyOf(row)} label={row.label} hit={hit} on={row.on} count={row.count ?? 0} onToggle={row.onToggle} mark={row.mark} data={row.data} />
    );
  const items = (
    <>
      {found.sections.map(({ section, rows: shown }, i) => (
        <Fragment key={section.id}>
          {i > 0 && <Menu.Separator className="ib-pm-sep" />}
          {section.title === null ? (
            shown.map(drawRow)
          ) : (
            <Menu.Group data-list-filter-group={section.id === 'projects' ? undefined : section.id}>
              <Menu.GroupLabel className="ib-pm-glabel">{section.title}</Menu.GroupLabel>
              {shown.map(drawRow)}
            </Menu.Group>
          )}
        </Fragment>
      ))}
      {onClear && (
        <>
          {found.sections.length > 0 && <Menu.Separator className="ib-pm-sep" />}
          <Menu.Item key={found.searching && found.matches === 0 ? 'clear:kept' : 'clear'} className="ib-pmi" onClick={onClear} data-list-filter-clear="">
            <Icon name="x" />
            <span className="ib-pmi-l">Clear filters</span>
          </Menu.Item>
        </>
      )}
    </>
  );

  const menu = (
    <Menu.Root handle={handle} open={open} onOpenChange={onOpenChange} modal={phone}>
      <Menu.Portal container={portal ?? undefined}>
        {phone && <Menu.Backdrop className="ib-pm-scrim" />}
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={6} data-phone={phone ? '' : undefined} data-list-filter-searchable={searchable ? '' : undefined}>
          <Menu.Popup className="ib-pm ib-pc-menu ib-lflt-menu" aria-label="Filter" data-list-filter-menu="" data-list-filter-searchable={searchable ? '' : undefined}>
            <div className="ib-pm-title" aria-hidden="true">
              Filter
            </div>
            {searchable ? (
              <>
                <div className="ib-lflt-top">
                  <div className="ib-lflt-find">
                    <Icon name="search" />
                    <Menu.Input
                      aria-label={FIND_WORDS}
                      placeholder={FIND_WORDS}
                      onKeyDown={(event: React.KeyboardEvent<HTMLInputElement> & { preventBaseUIHandler?: () => void }) => {
                        // During IME composition Enter and Escape are the IME's (commit, cancel): no tick, no close.
                        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                          if (event.key === 'Enter' || event.key === 'Escape') {
                            event.preventBaseUIHandler?.();
                            event.stopPropagation();
                          }
                          return;
                        }
                        if (STEP_KEYS.has(event.key)) arrowed.current = true;
                        // With nothing matching, Enter acts only on a row an arrow picked since the last key typed.
                        const enterBlocked = event.key === 'Enter' && found.searching && found.matches === 0 && !arrowed.current;
                        // Escape empties the field first; with the field empty it closes the menu as always.
                        if (!enterBlocked && (event.key !== 'Escape' || query === '')) return;
                        event.preventDefault();
                        event.preventBaseUIHandler?.();
                        if (enterBlocked) return;
                        event.stopPropagation();
                        setQuery('');
                      }}
                      data-list-filter-search=""
                    />
                    <Menu.Clear className="ib-lflt-clear" aria-label={CLEAR_WORDS} aria-hidden={false} data-list-filter-search-clear="">
                      <Icon name="x" />
                    </Menu.Clear>
                  </div>
                </div>
                <div className="ib-sr" role="status" data-list-filter-search-status="">
                  {said}
                </div>
                {found.searching && found.matches === 0 && (
                  <div className="ib-lflt-none" data-list-filter-none="">
                    {nothingMatches(typed)}
                  </div>
                )}
                {found.searching && found.matches === 0 && (found.sections.length > 0 || onClear) && <div className="ib-pm-sep" aria-hidden="true" />}
                <Menu.List className="ib-lflt-list">{items}</Menu.List>
              </>
            ) : (
              items
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );

  // The highlight goes to the first match as you type (with a match, the first row is one: listFilterSearch.ts); Enter
  // ticks or unticks it like any row. With no match it goes nowhere (`keyOf`, the Enter guard), so Enter never unticks
  // a row kept only because it is ticked.
  return searchable ? (
    <Menu.FilterProvider
      filter={null}
      value={query}
      onValueChange={(next) => {
        arrowed.current = false;
        setQuery(next);
      }}
      autoHighlight={found.matches > 0}
    >
      {menu}
    </Menu.FilterProvider>
  ) : (
    menu
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
