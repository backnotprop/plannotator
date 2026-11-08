/**
 * The list's filter in its header (the owner, 2026-11-08: "it needs to be the classic filter icon and nothing else in
 * the header under any state. A number badge can show and the filter icon can change color. That's all I want."; the
 * rule is listFilter.ts).
 *
 * - The header holds the filter icon (three lines narrowing) alone, at every width. With picks it takes the accent
 *   colour and a small count in its corner (`CountBadge`, the PRs button's size): one per ticked row. No tokens, no line over the list: what is picked is read in the menu.
 * - The menu (Base UI's: arrows, Home/End, type-ahead, Escape and Tab close, focus back to the funnel): Updated (Today,
 *   Last 7 days, Last 30 days, Custom range…), Agent (several; only with two agents or more), Pull request (Open,
 *   Draft, Merged, Closed, Has a PR, No PR, several; behind `LIST_FILTER_PULLS`), then Project last, since the
 *   sidebar already narrows by project (each project, several; only on the Inbox page and with two projects or
 *   more). Each row shows how many threads it would leave and a tick when picked, then "Clear filters". It stays open while picking. A phone draws it as the bottom
 *   sheet titled "Filter".
 * - Custom range… opens a small panel by the funnel: From, To, Apply.
 * - Nothing matches: `ListFilterEmpty` in the list's body, "No threads match" and Clear filters.
 *
 * No shortcut of its own.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { formatCount } from '../format';
import { HostMark, Icon } from '../icons';
import { Tip } from './Tip';
import { RefMarkIcon } from '../board/RefMark';
import { CountBadge } from './CountBadge';
import {
  NO_LIST_FILTER,
  PULL_OPTIONS,
  UPDATED_OPTIONS,
  listFilterPullsOn,
  rowPullMatches,
  type PullPick,
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

function CheckRow({ label, on, count, onToggle, mark, data }: { label: string; on: boolean; count: number; onToggle: () => void; mark: React.ReactNode; data: Record<string, string> }) {
  return (
    <Menu.CheckboxItem className="ib-pmi" label={label} checked={on} onCheckedChange={onToggle} closeOnClick={false} {...data}>
      {mark}
      <span className="ib-pmi-l" dir="auto">
        {label}
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
  const filter = appliedFilter(source.filter, scoped);
  const [open, setOpen] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
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

  const showProjects = !scoped && projects.length > 1;
  const showAgents = agents.length > 1;
  const set = (next: Partial<ListFilter>) => onChange({ ...source.filter, ...next });
  const custom = filter.updated !== null && typeof filter.updated !== 'string' ? filter.updated : null;
  const name = count > 0 ? `Filter, ${count} active` : 'Filter';

  const pulls = listFilterPullsOn();
  const projectGroup = showProjects && (
    <Menu.Group>
      <Menu.GroupLabel className="ib-pm-glabel">Project</Menu.GroupLabel>
      {projects.map((p) => (
        <CheckRow
          key={p.id}
          label={p.name}
          on={filter.projects.includes(p.id)}
          count={countWhere(rows, filter, now, 'projects', (row) => row.project.id === p.id)}
          onToggle={() => set({ projects: toggled(source.filter.projects, p.id) })}
          mark={<Icon name="folder" />}
          data={{ 'data-list-filter-project': p.id }}
        />
      ))}
    </Menu.Group>
  );

  return (
    <>
      <Menu.Root open={open} onOpenChange={setOpen} modal={phone}>
        <Tip content={count > 0 ? `Filter · ${count} active` : 'Filter'}>
          <Menu.Trigger ref={trigger} className="ib-lflt" aria-label={name} data-set={count > 0 ? '' : undefined} data-list-filter="">
            <span className="ib-lflt-g ib-cnt-host">
              <FilterGlyph size={phone ? 20 : 16} />
              {count > 0 && <CountBadge count={count} data={{ 'data-list-filter-count': '' }} />}
            </span>
          </Menu.Trigger>
        </Tip>
        <Menu.Portal container={portal ?? undefined}>
          {phone && <Menu.Backdrop className="ib-pm-scrim" />}
          <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={6} data-phone={phone ? '' : undefined}>
            {/* The order (the owner, 2026-11-08): what the sidebar cannot do first, Project last (the sidebar has its own). */}
            <Menu.Popup className="ib-pm ib-pc-menu ib-lflt-menu" aria-label="Filter" data-list-filter-menu="">
              <div className="ib-pm-title" aria-hidden="true">
                Filter
              </div>
              <Menu.Group data-list-filter-group="updated">
                <Menu.GroupLabel className="ib-pm-glabel">Updated</Menu.GroupLabel>
                {UPDATED_OPTIONS.map((o) => (
                  <CheckRow
                    key={o.value}
                    label={o.label}
                    on={filter.updated === o.value}
                    count={countWhere(rows, filter, now, 'updated', inSpan(o.value, now))}
                    onToggle={() => set({ updated: filter.updated === o.value ? null : o.value })}
                    mark={<Icon name="clock" />}
                    data={{ 'data-list-filter-updated': o.value }}
                  />
                ))}
                <Menu.Item
                  className="ib-pmi"
                  label="Custom range"
                  onClick={() => {
                    setOpen(false);
                    requestAnimationFrame(() => setRangeOpen(true));
                  }}
                  data-checked={custom ? '' : undefined}
                  data-list-filter-updated="range"
                >
                  <Icon name="clock" />
                  <span className="ib-pmi-l">{custom ? rangeWords(custom) : 'Custom range…'}</span>
                  {custom && <span className="ib-pmi-n">{formatCount(countWhere(rows, filter, now, 'updated', inSpan(custom, now)))}</span>}
                  {tick(custom !== null)}
                </Menu.Item>
              </Menu.Group>
              {showAgents && (
                <>
                  <Menu.Separator className="ib-pm-sep" />
                  <Menu.Group data-list-filter-group="agents">
                    <Menu.GroupLabel className="ib-pm-glabel">Agent</Menu.GroupLabel>
                    {agents.map((a) => (
                      <CheckRow
                        key={a.name}
                        label={a.name}
                        on={filter.agents.includes(a.name)}
                        count={countWhere(rows, filter, now, 'agents', (row) => rowAgentNames(row).includes(a.name))}
                        onToggle={() => set({ agents: toggled(source.filter.agents, a.name) })}
                        mark={
                          <span className="ib-lflt-host" aria-hidden="true">
                            <HostMark host={a.host} />
                          </span>
                        }
                        data={{ 'data-list-filter-agent': a.name }}
                      />
                    ))}
                  </Menu.Group>
                </>
              )}
              {pulls && (
                <>
                  <Menu.Separator className="ib-pm-sep" />
                  <Menu.Group data-list-filter-group="pulls">
                    <Menu.GroupLabel className="ib-pm-glabel">Pull request</Menu.GroupLabel>
                    {PULL_OPTIONS.map((o) => (
                      <CheckRow
                        key={o.value}
                        label={o.label}
                        on={filter.pulls.includes(o.value)}
                        count={countWhere(rows, filter, now, 'pulls', (row) => rowPullMatches(row, o.value))}
                        onToggle={() => set({ pulls: toggled(source.filter.pulls, o.value) as PullPick[] })}
                        mark={o.value === 'none' ? <Icon name="minus" /> : <RefMarkIcon kind="pr" state={o.value === 'any' ? 'unknown' : o.value} size={16} />}
                        data={{ 'data-list-filter-pull': o.value }}
                      />
                    ))}
                  </Menu.Group>
                </>
              )}
              {projectGroup && (
                <>
                  <Menu.Separator className="ib-pm-sep" />
                  {projectGroup}
                </>
              )}
              {count > 0 && (
                <>
                  <Menu.Separator className="ib-pm-sep" />
                  <Menu.Item className="ib-pmi" onClick={() => onChange(clearedFrom(source.filter, scoped))} data-list-filter-clear="">
                    <Icon name="x" />
                    <span className="ib-pmi-l">Clear filters</span>
                  </Menu.Item>
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <RangePanel key={rangeOpen ? 'open' : 'shut'} open={rangeOpen} onOpenChange={setRangeOpen} anchor={trigger} portal={portal} phone={phone} start={custom} onApply={(range) => set({ updated: range })} />
    </>
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
 * Clear filters: every pick that applies here. On a project's page that is all but the Project picks, which
 * stepped aside there and come back on Inbox.
 */
export function clearedFrom(filter: ListFilter, scoped: boolean): ListFilter {
  return scoped ? { ...NO_LIST_FILTER, projects: filter.projects } : NO_LIST_FILTER;
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
