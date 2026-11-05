import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import type { InboxTidyCombine, InboxTidyPlan, InboxTidyRun, InboxTidyRunAgent } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { formatCount } from '../format';
import { HostMark, Icon } from '../icons';
import { Tip } from './Tip';
import { LIST_LOOK_OPTIONS, type ListLook, type MenuLookKey } from '../listLook';
import { shortProjectNames } from '../projectLabels';
import { THREAD_PANEL_LABEL } from '../threadPanel';

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
  plan: InboxTidyPlan | null;
  /** The last run (within a day), or null. */
  run: InboxTidyRun | null;
  start: (sessions: readonly string[], key: string) => Promise<string | null>;
  refresh: () => void;
  /** Combine each ticked pair, `from` into `into`, with one Undo. The window's: answers why it stopped, or null. */
  combine?: (pairs: readonly InboxTidyCombine[]) => Promise<string | null>;
  /** The menu or the popover opened or closed: what it shows is read while it is open (useTidy). */
  shown?: (open: boolean) => void;
  /** The person is about to open the menu (a pointer on ⋮, or focus): a list or Board read meanwhile is read now. */
  warm?: () => void;
  /** That read (`warm`) is still out: the plan may be stale, so the menu shows Tidy as while it is first read. */
  pending?: boolean;
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
export function useTidy(scope: string | null, surface: TidySurface, version: unknown, enabled = true): TidyController {
  const [plan, setPlan] = useState<InboxTidyPlan | null>(null);
  const seq = useRef(0);
  /** A list or Board read happened since the plan was last read. */
  const stale = useRef(false);
  /** The menu or the popover is open. */
  const open = useRef(false);
  /** A stale plan is being read again (`warm`): until it lands the menu shows no count (a touch opens ⋮ at once). */
  const [pending, setPending] = useState(false);
  const refresh = useCallback(() => {
    const mine = ++seq.current;
    stale.current = false;
    inboxApi
      .tidy(scope, surface)
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
    if (!enabled || !stale.current) return;
    setPending(true);
    refresh();
  }, [enabled, refresh]);
  const shown = useCallback(
    (now: boolean) => {
      open.current = now;
      if (now) warm();
    },
    [warm],
  );
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
    async (sessions: readonly string[], key: string): Promise<string | null> => {
      try {
        const answer = await inboxApi.startTidy({ sessions, idempotency_key: key, project: scope, surface });
        setPlan((current) => (current ? { ...current, run: answer.run } : current));
        refresh();
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : 'Tidy did not start.';
      }
    },
    [scope, surface, refresh],
  );
  return { surface, scope, plan, run, start, refresh, shown, warm, pending };
}


/**
 * One of the ⋮ menu's options: a plain checkbox, no icon (the owner, 2026-11-02: "Honestly, those could all just be
 * check boxes anyways. They don't look right as icons"). The box sits where Tidy's and Refresh's icons sit, so every
 * label starts at one edge. A tick leaves the menu open, so the next can be tried, unless `closeOnClick`.
 */
function MenuCheckbox({
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

/** "Tidy · 3/4" while a run shows. */
const runLabel = (run: InboxTidyRun) => `Tidy · ${run.done}/${run.agents.length}`;

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
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
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
              <Menu.Item className="ib-pmi" label="Refresh" data-tidy-refresh="" onClick={onRefresh}>
                <Icon name="refresh" size={15} />
                Refresh
              </Menu.Item>
              {look && onLook && (
                <>
                  <Menu.Separator className="ib-pm-sep" />
                  <Menu.Group>
                    <Menu.GroupLabel className="ib-pm-glabel">Rows</Menu.GroupLabel>
                    {/* A tick changes the list at once and leaves the menu open, so the next can be tried. */}
                    {LIST_LOOK_OPTIONS.map((option) => (
                      <MenuCheckbox key={option.key} label={option.label} checked={look[option.key]} onChange={(on) => onLook(option.key, on)} data-list-look={option.key} />
                    ))}
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

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

/** One suggestion per project the others go into, read by the name it will have: alone, nothing clashes. */
function combineGroups(pairs: readonly InboxTidyCombine[]) {
  const groups = new Map<string, { into: InboxTidyCombine['into']; name: string; pairs: InboxTidyCombine[] }>();
  for (const pair of pairs) {
    const group = groups.get(pair.into.id) ?? { into: pair.into, name: shortProjectNames([pair.into]).get(pair.into.id) ?? pair.into.name, pairs: [] };
    group.pairs.push(pair);
    groups.set(pair.into.id, group);
  }
  return [...groups.values()];
}

/** The last run (when there is one), then the picker when there is something to ask. */
function TidyPanel({ tidy: given, onDone }: { tidy: TidyController; onDone: () => void }) {
  // A stale plan still being read again (`pending`: a phone taps ⋮, then Tidy, before it lands): drawn as while
  // it is first read, never the old plan or run.
  const tidy = given.pending ? { ...given, plan: null, run: null } : given;
  const { plan, run } = tidy;
  const offered = (plan?.agents.length ?? 0) > 0 || (plan?.combine?.length ?? 0) > 0;
  return (
    <>
      {run && <RunPanel run={run} />}
      {(offered || !run) && <TidyPicker tidy={tidy} onDone={onDone} below={run !== null} />}
    </>
  );
}

function TidyPicker({ tidy, onDone, below }: { tidy: TidyController; onDone: () => void; below: boolean }) {
  const { plan } = tidy;
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // One key per opening: a second press (or a retry) answers the same run.
  const [key] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `tidy-${Date.now()}-${Math.random()}`));
  if (!plan) return <div className="ib-tidy-top"><b>Tidy</b></div>;
  const combine = plan.combine ?? [];
  if (plan.agents.length === 0 && combine.length === 0)
    return (
      <div className="ib-tidy-top" data-tidy-empty="">
        <b>Tidy</b>
        <span>Nothing to ask</span>
      </div>
    );
  const agents = plan.agents;
  const picked = agents.filter((a) => !off.has(a.session));
  const pickedCombine = combine.filter((pair) => !off.has(pair.from.id));
  const allThreads = combine.length === 0 && agents.every((a) => a.items.every((i) => i.thread_id !== null));
  const tick = (ids: readonly string[], on: boolean) =>
    setOff((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  return (
    <>
      <div className="ib-tidy-top" data-below={below ? '' : undefined}>
        <b>Tidy</b>
        <span>{plural(plan.count, allThreads ? 'thread' : 'item')}</span>
      </div>
      {agents.length > 0 && (
        <ul className="ib-tidy-ags">
          {agents.map((agent) => (
            <li key={agent.session}>
              <label className="ib-tidy-ag" data-tidy-agent={agent.session}>
                <input type="checkbox" checked={!off.has(agent.session)} onChange={(event) => tick([agent.session], event.target.checked)} />
                <HostMark host={agent.host} />
                <span className="ib-tidy-nm">{agent.name}</span>
                <em>{formatCount(agent.items.length)}</em>
              </label>
            </li>
          ))}
        </ul>
      )}
      {combine.length > 0 && (
        <>
          <div className="ib-tidy-sub" data-below={agents.length > 0 ? '' : undefined}>
            Combine projects
          </div>
          <ul className="ib-tidy-ags">
            {combineGroups(combine).map((group) => {
              const ids = group.pairs.map((pair) => pair.from.id);
              return (
                <li key={group.into.id}>
                  <label className="ib-tidy-ag ib-tidy-cmb" data-tidy-combine={group.into.id}>
                    <input type="checkbox" checked={!ids.some((id) => off.has(id))} onChange={(event) => tick(ids, event.target.checked)} />
                    <Icon name="folder" size={15} />
                    <Tip content={[group.into.root, ...group.pairs.map((pair) => pair.from.root)].join('\n')}>
                      <span className="ib-tidy-nm">
                        <b dir="auto">{group.name}</b>
                        <small>
                          {formatCount(group.pairs.length + 1)} folders, {group.pairs[0]!.why}
                        </small>
                      </span>
                    </Tip>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {error && (
        <p className="ib-tidy-err" role="alert">
          {error}
        </p>
      )}
      <div className="ib-tidy-bot">
        <button
          type="button"
          className="ib-btn ib-pri ib-sm"
          disabled={(picked.length === 0 && pickedCombine.length === 0) || sending}
          data-tidy-go=""
          onClick={async () => {
            setSending(true);
            // The combines first: they are this window's, and an agent's prompt can wait for a retry.
            let failed: string | null = null;
            if (pickedCombine.length > 0) {
              const names = new Map(combineGroups(pickedCombine).map((group) => [group.into.id, group.name]));
              failed = (await tidy.combine?.(pickedCombine.map((pair) => ({ ...pair, into: { ...pair.into, name: names.get(pair.into.id) ?? pair.into.name } })))) ?? null;
            }
            if (!failed && picked.length > 0) {
              failed = await tidy.start(
                picked.map((a) => a.session),
                key,
              );
            }
            setSending(false);
            if (failed) setError(failed);
            else onDone();
          }}
        >
          Tidy
        </button>
      </div>
    </>
  );
}

/** Where each asked agent stands. */
function runState(agent: InboxTidyRunAgent): string {
  switch (agent.state) {
    case 'waiting':
      return agent.reach === 'next_call' ? 'At its next Inbox call' : 'Waiting';
    case 'delivered':
      return 'Delivered';
    case 'tidied':
      return agent.updated > 0 ? `${plural(agent.updated, 'thread')} updated` : 'Updated';
    case 'nothing':
      return 'Nothing to change';
    case 'ended':
      return 'Session ended';
  }
}

function RunPanel({ run }: { run: InboxTidyRun }) {
  return (
    <>
      <div className="ib-tidy-top">
        <b>{runLabel(run)}</b>
        {run.updated > 0 && <span>{plural(run.updated, 'thread')} updated</span>}
      </div>
      <ul className="ib-tidy-ags">
        {run.agents.map((agent) => (
          <li key={agent.session} className="ib-tidy-ag ib-tidy-run" data-tidy-run-agent={agent.session} data-state={agent.state}>
            <span />
            <HostMark host={agent.host} />
            <span className="ib-tidy-nm">{agent.name}</span>
            <em>{runState(agent)}</em>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A Tidy note in its thread: one quiet line, "Tidy sent to Claude Code · 8:54 AM". */
export function TidyNote({ agent, time, fullWhen }: { agent: string; time: string; fullWhen: string }) {
  return (
    <p className="ib-tidy-mark" data-tidy-note="">
      <Icon name="todo" size={14} />
      <span>
        Tidy sent to {agent}
        {' · '}
        <Tip content={fullWhen}>
          <span data-full-when="">{time}</span>
        </Tip>
      </span>
    </p>
  );
}
