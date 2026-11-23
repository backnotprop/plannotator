import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import { isInboxId, type InboxTidyCombine, type InboxTidyRun } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { formatCount } from '../format';
import { Icon } from '../icons';
import type { PressKeys } from '../pressKeys';
import { listTargets, readAcross, startAcross, type TidyAcrossAgent, type TidyAcrossPlan } from '../tidyAcross';
import type { MachinesModel } from '../machines';
import { machineOf } from '../inboxUrl';
import { runLabel, TidyPanel } from './TidyPanel';
import { Tip } from './Tip';
import { ShortcutHint, useShortcutAria } from '../shortcuts/hint';
import { inboxAppShortcuts } from '../shortcuts/app.shortcuts';
import { LIST_LOOK_OPTIONS, type ListLook, type MenuLookKey } from '../listLook';
import { THREAD_PANEL_LABEL } from '../threadPanel';
import { LIST_VIEW_LABEL, LIST_VIEW_OPTIONS, type ListView } from '../listView';
import { STARRED_ABOVE_LABEL } from '../starredPills';
import { SHOW_TAG_COLOURS_LABEL } from '../tagColours';
import { AGENT_STATUS_LABEL, setAgentStatus, useAgentStatusOn } from '../agents/agentStatus';

/**
 * Tidy (owner-approved design, 2026-10-28, simplified the same day: "quiet,
 * elegant"): the ⋮ menu in the list's and the Board's header holds "Tidy N"
 * and "Refresh". Tidy opens a small popover (a sheet on a phone): one
 * checkbox per agent with its count and one Tidy button. During and after a
 * run the same popover shows where each agent stands. In a thread, a Tidy
 * note is one quiet line. No banner, no shortcut, no schedule.
 */

export type TidySurface = 'list' | 'board';

export interface TidyController {
  surface: TidySurface;
  scope: string | null;
  plan: TidyAcrossPlan | null;
  /** The last run (within a day), or null. */
  run: InboxTidyRun | null;
  /** Asks the ticked agents, each on its own machine, with the person's own words (approval "inbox-multi-select"). */
  start: (agents: readonly TidyAcrossAgent[], key: PressKeys, words?: string) => Promise<string | null>;
  /** A Tidy of picked threads: how many the person picked (the popover's "3 selected"). Absent: the list's or the Board's. */
  picked?: number;
  refresh: () => void;
  /** Combine each ticked pair, `from` into `into`, with one Undo. The window's: answers why it stopped, or null. */
  combine?: (pairs: readonly InboxTidyCombine[]) => Promise<string | null>;
  /** The menu or the popover opened or closed: what it shows is read while it is open (useTidy). */
  shown?: (open: boolean) => void;
  /** The person is about to open the menu (a pointer on ⋮, or focus): a list or Board read meanwhile is read now. */
  warm?: () => void;
  /** That read (`warm`) is still out: the plan may be stale, so the menu shows Tidy as while it is first read. */
  pending?: boolean;
  /**
   * A list read that brought nothing new (so `version` did not move, App's listSame.ts): it still counts as a list
   * read, as when every read drew the list again. Read now while shown, else the plan is stale.
   */
  listRead?: () => void;
}

/** How long the window polls a run's progress. */
const TIDY_POLL_MS = 10 * 60_000;

/**
 * Reads who Tidy would ask in `scope`: when it opens, and every few seconds
 * while a run is under way. A list or Board read (`version` changes) reads it
 * again while the menu or the popover shows it (#2593: not after every agent
 * message); while they are closed it only marks the plan stale, read as the
 * person reaches for ⋮ (`warm`) or opens it (`shown`).
 */
export function useTidy(scope: string | null, surface: TidySurface, version: unknown, enabled = true, machines?: MachinesModel): TidyController {
  const [plan, setPlan] = useState<TidyAcrossPlan | null>(null);
  // Linked machines that take Tidy are read and asked too, each about its own threads (tidyAcross.ts).
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const seq = useRef(0);
  /** A list or Board read happened since the plan was last read. */
  const stale = useRef(false);
  /** The menu or the popover is open. */
  const open = useRef(false);
  /** A stale plan is being read again (`warm`): until it lands the menu shows no count (a touch opens ⋮ at once). */
  const [pending, setPending] = useState(false);
  /** The linked machines are read once the person reaches for Tidy; until then a load reads this machine's alone. */
  const far = useRef(false);
  const refresh = useCallback(() => {
    const mine = ++seq.current;
    stale.current = false;
    // A project's list is that project's machine's alone.
    const targets = scope ? [{ machine: machineOf(scope), name: null }] : machinesRef.current && far.current ? listTargets(machinesRef.current) : [{ machine: null, name: null }];
    readAcross(targets, (target) => inboxApi.tidy(scope, surface, target.machine))
      .then((next) => {
        if (mine === seq.current) setPlan(next);
      })
      .catch(() => {})
      .finally(() => {
        if (mine === seq.current) setPending(false);
      });
  }, [scope, surface]);
  /** The scope (its `refresh`) the plan was last read for while enabled; null after a disable, so a return reads it again. */
  const readFor = useRef<typeof refresh | null>(null);
  useEffect(() => {
    if (!enabled) {
      readFor.current = null;
      return;
    }
    // Only the list or Board moved, and nothing shows the plan: read it when something does.
    if (readFor.current === refresh && !open.current) {
      stale.current = true;
      return;
    }
    // Counted as read only once the read starts: a list read within these 250 ms puts it off, never drops it.
    const timer = setTimeout(() => {
      readFor.current = refresh;
      refresh();
    }, 250);
    return () => clearTimeout(timer);
  }, [refresh, version, enabled]);
  const warm = useCallback(() => {
    const first = !scope && !far.current && (machinesRef.current?.linked.length ?? 0) > 0;
    far.current = true;
    if (!enabled || (!stale.current && !first)) return;
    setPending(true);
    refresh();
  }, [enabled, refresh, scope]);
  const shown = useCallback(
    (now: boolean) => {
      open.current = now;
      if (now) warm();
    },
    [warm],
  );
  const listRead = useCallback(() => {
    // Not read for this scope yet: its first read is on its way anyway.
    if (!enabled || readFor.current !== refresh) return;
    if (open.current) refresh();
    else stale.current = true;
  }, [enabled, refresh]);
  const run = plan?.run ?? null;
  // Poll while a run goes, for 10 minutes at most: an agent that cannot say it
  // is done (Codex, MCP only) would otherwise keep it going all day. List and
  // Board reads (`version`) still read it after that.
  const underway = run !== null && run.done < run.agents.length;
  const runAt = run ? Date.parse(run.at) : 0;
  useEffect(() => {
    if (!underway || !enabled) return;
    const left = runAt + TIDY_POLL_MS - Date.now();
    if (left <= 0) return;
    const timer = setInterval(refresh, 5000);
    const stop = setTimeout(() => clearInterval(timer), left);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [underway, runAt, refresh, enabled]);
  const start = useCallback(
    async (agents: readonly TidyAcrossAgent[], key: PressKeys, words?: string): Promise<string | null> => {
      const failed = await startAcross(agents, key, (machine, sessions, partKey) =>
        inboxApi.startTidy({ sessions, idempotency_key: partKey, project: scope, surface, ...(words ? { words } : {}) }, machine),
      );
      refresh();
      return failed;
    },
    [scope, surface, refresh],
  );
  return { surface, scope, plan, run, start, refresh, shown, warm, pending, listRead };
}


/**
 * One of the ⋮ menu's options: a plain checkbox, no icon (the owner, 2026-11-02: "Honestly, those could all just be
 * check boxes anyways. They don't look right as icons"). The box sits where Tidy's and Refresh's icons sit, so every
 * label starts at one edge. A tick leaves the menu open, so the next can be tried, unless `closeOnClick`.
 */
export function MenuCheckbox({
  label,
  checked,
  onChange,
  closeOnClick = false,
  ...data
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  closeOnClick?: boolean;
} & { [data: `data-${string}`]: string }) {
  return (
    <Menu.CheckboxItem className="ib-pmi" label={label} checked={checked} onCheckedChange={(on: boolean) => onChange(on)} closeOnClick={closeOnClick} {...data}>
      <span className="ib-pmi-box" aria-hidden="true" data-on={checked ? '' : undefined}>
        {checked && <Icon name="check" size={11} />}
      </span>
      <span className="ib-pmi-l">{label}</span>
    </Menu.CheckboxItem>
  );
}

/**
 * "Show agent status" (agents/agentStatus.ts, owner 2026-11-18): the same switch as Settings → General → Appearance's
 * row, so the two always agree. Off by default.
 */
export function AgentStatusMenuItem() {
  const on = useAgentStatusOn();
  return <MenuCheckbox label={AGENT_STATUS_LABEL} checked={on} onChange={(next) => void setAgentStatus(next)} data-agent-status-option="" />;
}

/**
 * The list's view (listView.ts): Grouped, List or Agents, one choice (`menuitemradio`, its state announced), drawn as
 * the checkboxes are with a round box, under its label (the radio group is the labelled group). A pick changes the
 * list at once and leaves the menu open, as a tick does.
 */
function MenuViewChoice({ view, onChange }: { view: ListView; onChange: (view: ListView) => void }) {
  return (
    <Menu.RadioGroup value={view} onValueChange={(next: ListView) => onChange(next)}>
      <Menu.GroupLabel className="ib-pm-glabel">{LIST_VIEW_LABEL}</Menu.GroupLabel>
      {LIST_VIEW_OPTIONS.map((option) => (
        <Menu.RadioItem key={option.value} className="ib-pmi" value={option.value} label={option.label} closeOnClick={false} data-list-view={option.value}>
          <span className="ib-pmi-box" aria-hidden="true" data-radio="" data-on={view === option.value ? '' : undefined} />
          <span className="ib-pmi-l">{option.label}</span>
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  );
}

/**
 * The header's ⋮: Tidy (with its count, or the run's progress) and Refresh.
 * `className` places it in its header (the list's or the Board's). The list
 * passes its look (`look`, `onLook`): four checkboxes follow Refresh
 * (approval "inbox-list-options"); the Board passes none.
 */
export function TidyMenu({
  tidy,
  phone,
  onRefresh,
  className,
  hideAway,
  look,
  onLook,
  threadPanel,
  onCustomize,
  view,
  starredAbove,
  onSelect,
  markAllRead,
  showArchived,
  tagColours,
}: {
  tidy: TidyController;
  phone: boolean;
  onRefresh: () => void;
  className: string;
  /** Linked machines: "Hide offline machines", checked while their rows are hidden. Absent (nothing linked): no item. */
  hideAway?: { on: boolean; onChange: (hide: boolean) => void };
  look?: ListLook;
  onLook?: (key: MenuLookKey, on: boolean) => void;
  /** The thread panel view (threadPanel.ts), checked while it is the default. Absent (a phone, the tour): no item. */
  threadPanel?: { on: boolean; onChange: (on: boolean) => void };
  /** "Customize rows…", last in the Rows group: Settings → Rows. Absent (the tour): no item. */
  onCustomize?: () => void;
  /** The list's view (listView.ts), Grouped or List, first of the options. Absent (the Board, the tour): no item. */
  view?: { value: ListView; onChange: (view: ListView) => void };
  /**
   * "Keep starred above the list" (starredPills.ts), last in the View group: checked while the starred threads are
   * pills above the list and not a sidebar section. Absent (the Board, the tour, an Inbox that keeps no stars): no item.
   */
  starredAbove?: { on: boolean; onChange: (on: boolean) => void };
  /** "Select threads", after Tidy: the list starts picking rows (rowPicks.ts). Absent (the Board, the tour): no item. */
  onSelect?: () => void;
  /**
   * "Mark all as read", after Select threads (markAllRead.ts): every row the list shows that takes Mark read, as the
   * project menu's item. Greyed while none does. Absent (the Board, the tour): no item.
   */
  markAllRead?: { disabled: boolean; onClick: () => void };
  /** "Show archived" (approval "inbox-archived-group"), after it: the Archived group under the list. Absent: no item. */
  showArchived?: { on: boolean; onChange: (on: boolean) => void };
  /**
   * "Show tag colors" (tagColours.ts), in the Rows group after the look's checkboxes: off, no row is tinted and no row
   * names its tag. The same on every linked machine. Absent (an Inbox before tag colours, the Board, the tour): no item.
   */
  tagColours?: { on: boolean; onChange: (on: boolean) => void };
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  // Shift+R runs Refresh here too (approval "inbox-refresh-key"): its key name, gone with single keys off.
  const refreshKeys = useShortcutAria({ scope: inboxAppShortcuts, action: 'refresh' });
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  // A stale plan read again as ⋮ is reached for (touch opens it at once): drawn as while it is first read, never its old count.
  const plan = tidy.pending ? null : tidy.plan;
  const run = tidy.pending ? null : tidy.run;
  const count = plan?.count ?? 0;
  // Still reading (plan null): enabled, so the menu does not flash disabled on load.
  const canOpen = plan === null || run !== null || count > 0;
  // What the menu and the popover show is read while one of them is open (useTidy).
  const { shown, warm } = tidy;
  const showing = menuOpen || popOpen;
  useEffect(() => {
    shown?.(showing);
  }, [shown, showing]);
  useEffect(() => () => shown?.(false), [shown]);
  return (
    <>
      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <Menu.Trigger
          ref={trigger}
          className={`ib-tidytrig ${className}`}
          aria-label="More"
          data-tidy-menu=""
          data-open={popOpen ? '' : undefined}
          onPointerEnter={warm}
          onPointerDown={warm}
          onFocus={warm}
        >
          <Icon name="dots" size={phone ? 20 : 18} />
        </Menu.Trigger>
        <Menu.Portal container={portal ?? undefined}>
          {phone && <Menu.Backdrop className="ib-pm-scrim" />}
          <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={4} data-phone={phone ? '' : undefined}>
            <Menu.Popup className="ib-pm" aria-label={tidy.surface === 'board' ? 'Board' : 'Inbox'} data-tidy-menu-popup="">
              <div className="ib-pm-title" aria-hidden="true">
                {tidy.surface === 'board' ? 'Board' : 'Inbox'}
              </div>
              <Menu.Item
                className="ib-pmi"
                label="Tidy"
                disabled={!canOpen}
                data-tidy-item=""
                onClick={() => {
                  setMenuOpen(false);
                  tidy.refresh();
                  setPopOpen(true);
                }}
              >
                <Icon name="todo" size={15} />
                {/* New work first: its count; else the last run's progress. */}
                {count > 0 || !run ? 'Tidy' : runLabel(run)}
                {count > 0 && <span className="ib-pmi-n">{formatCount(count)}</span>}
              </Menu.Item>
              {onSelect && (
                <Menu.Item className="ib-pmi" label="Select threads" data-select-threads="" onClick={onSelect}>
                  <Icon name="todoOpen" size={15} />
                  Select threads
                </Menu.Item>
              )}
              {markAllRead && (
                <Menu.Item className="ib-pmi" label="Mark all as read" disabled={markAllRead.disabled} data-list-mark-all-read="" onClick={markAllRead.onClick}>
                  <Icon name="checkCircle" size={15} />
                  Mark all as read
                </Menu.Item>
              )}
              <Menu.Item className="ib-pmi" label="Refresh" data-tidy-refresh="" onClick={onRefresh} aria-keyshortcuts={refreshKeys}>
                <Icon name="refresh" size={15} />
                Refresh
                <ShortcutHint scope={inboxAppShortcuts} action="refresh" className="ib-kbd ib-pmi-kbd" />
              </Menu.Item>
              {view && (
                <>
                  <Menu.Separator className="ib-pm-sep" />
                  <MenuViewChoice view={view.value} onChange={view.onChange} />
                  {starredAbove && <MenuCheckbox label={STARRED_ABOVE_LABEL} checked={starredAbove.on} onChange={starredAbove.onChange} data-starred-above-option="" />}
                  {showArchived && <MenuCheckbox label="Show archived" checked={showArchived.on} onChange={showArchived.onChange} data-show-archived-option="" />}
                </>
              )}
              {/* About the sidebar's agents, not the list's rows: its own item after the View group (owner, 2026-11-18). */}
              {view && (
                <>
                  <Menu.Separator className="ib-pm-sep" />
                  <AgentStatusMenuItem />
                </>
              )}
              {look && onLook && (
                <>
                  <Menu.Separator className="ib-pm-sep" />
                  <Menu.Group>
                    <Menu.GroupLabel className="ib-pm-glabel">Rows</Menu.GroupLabel>
                    {/* A tick changes the list at once and leaves the menu open, so the next can be tried. */}
                    {LIST_LOOK_OPTIONS.map((option) => (
                      <MenuCheckbox key={option.key} label={option.label} checked={look[option.key]} onChange={(on) => onLook(option.key, on)} data-list-look={option.key} />
                    ))}
                    {tagColours && <MenuCheckbox label={SHOW_TAG_COLOURS_LABEL} checked={tagColours.on} onChange={tagColours.onChange} data-tag-colours-option="" />}
                    {onCustomize && (
                      // No icon (the owner, 2026-11-02): its words line up with the checkboxes' labels above it.
                      <Menu.Item className="ib-pmi ib-pmi-noicon" label="Customize rows…" onClick={onCustomize} data-customize-rows="">
                        <span className="ib-pmi-l">Customize rows…</span>
                      </Menu.Item>
                    )}
                  </Menu.Group>
                  {threadPanel && (
                    <>
                      <Menu.Separator className="ib-pm-sep" />
                      <Menu.Group>
                        <Menu.GroupLabel className="ib-pm-glabel">Thread panel</Menu.GroupLabel>
                        <MenuCheckbox label={THREAD_PANEL_LABEL} checked={threadPanel.on} onChange={threadPanel.onChange} data-thread-panel-option="" />
                      </Menu.Group>
                    </>
                  )}
                </>
              )}
              {hideAway && (
                <>
                  <Menu.Separator className="ib-pm-sep" />
                  <Menu.Group>
                    <Menu.GroupLabel className="ib-pm-glabel">Machines</Menu.GroupLabel>
                    <MenuCheckbox label="Hide offline machines" checked={hideAway.on} onChange={hideAway.onChange} closeOnClick data-hide-offline-machines="" />
                  </Menu.Group>
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Popover.Root open={popOpen} onOpenChange={setPopOpen} modal={phone}>
        <Popover.Portal container={portal ?? undefined}>
          {phone && <Popover.Backdrop className="ib-pm-scrim" />}
          <Popover.Positioner className="ib-tidy-pos" anchor={trigger} side="bottom" align="end" sideOffset={6} data-phone={phone ? '' : undefined}>
            <Popover.Popup className="ib-tidy" aria-label="Tidy" finalFocus={trigger} data-tidy-popover="">
              {popOpen && <TidyPanel tidy={tidy} onDone={() => setPopOpen(false)} />}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

/**
 * A Tidy note in its thread: one quiet line, "Tidy sent to Claude Code · 8:54 AM". A Combine's wake is the same note
 * (its run a `cmb_` id): "Combine sent to Claude Code · 8:54 AM" (approval "inbox-combine-across-computers": a Combine
 * is not a Tidy).
 */
export function TidyNote({ run, agent, time, fullWhen }: { run?: string; agent: string; time: string; fullWhen: string }) {
  return (
    <p className="ib-tidy-mark" data-tidy-note="">
      <Icon name="todo" size={14} />
      <span>
        {run && isInboxId('cmb', run) ? 'Combine' : 'Tidy'} sent to {agent}
        {' · '}
        <Tip content={fullWhen}>
          <span data-full-when="">{time}</span>
        </Tip>
      </span>
    </p>
  );
}

/** What a Combine left where it was, in the same quiet note style (CombineLeftNote.tsx). */
export { CombineLeftNote } from './CombineLeftNote';
