import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import type { InboxTidyCombine, InboxTidyPlan, InboxTidyRun, InboxTidyRunAgent } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { formatCount } from '../format';
import { HostMark, Icon } from '../icons';
import { Tip } from './Tip';
import { ShortcutHint, useShortcutAria } from '../shortcuts/hint';
import { inboxAppShortcuts } from '../shortcuts/app.shortcuts';
import { LIST_LOOK_OPTIONS, type ListLook, type MenuLookKey } from '../listLook';
import { shortProjectNames } from '../projectLabels';
import { THREAD_PANEL_LABEL } from '../threadPanel';
import { LIST_VIEW_LABEL, LIST_VIEW_OPTIONS, type ListView } from '../listView';
import { STARRED_ABOVE_LABEL } from '../starredPills';

export type TidySurface = 'list' | 'board';

export interface TidyController {
  surface: TidySurface;
  scope: string | null;
  plan: InboxTidyPlan | null;
  run: InboxTidyRun | null;
  start: (sessions: readonly string[], key: string) => Promise<string | null>;
  refresh: () => void;
  combine?: (pairs: readonly InboxTidyCombine[]) => Promise<string | null>;
  shown?: (open: boolean) => void;
  warm?: () => void;
  pending?: boolean;
  listRead?: () => void;
}

const TIDY_POLL_MS = 10 * 60_000;

export function useTidy(scope: string | null, surface: TidySurface, version: unknown, enabled = true): TidyController {
  const [plan, setPlan] = useState<InboxTidyPlan | null>(null);
  const seq = useRef(0);
  const stale = useRef(false);
  const open = useRef(false);
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
  const readFor = useRef<typeof refresh | null>(null);
  useEffect(() => {
    if (!enabled) {
      readFor.current = null;
      return;
    }
    if (readFor.current === refresh && !open.current) {
      stale.current = true;
      return;
    }
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
  const listRead = useCallback(() => {
    if (!enabled || readFor.current !== refresh) return;
    if (open.current) refresh();
    else stale.current = true;
  }, [enabled, refresh]);
  const run = plan?.run ?? null;
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
  return { surface, scope, plan, run, start, refresh, shown, warm, pending, listRead };
}

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

const runLabel = (run: InboxTidyRun) => `Tidy · ${run.done}/${run.agents.length}`;

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
}: {
  tidy: TidyController;
  phone: boolean;
  onRefresh: () => void;
  className: string;
  hideAway?: { on: boolean; onChange: (hide: boolean) => void };
  look?: ListLook;
  onLook?: (key: MenuLookKey, on: boolean) => void;
  threadPanel?: { on: boolean; onChange: (on: boolean) => void };
  onCustomize?: () => void;
  view?: { value: ListView; onChange: (view: ListView) => void };
  starredAbove?: { on: boolean; onChange: (on: boolean) => void };
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const refreshKeys = useShortcutAria({ scope: inboxAppShortcuts, action: 'refresh' });
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const plan = tidy.pending ? null : tidy.plan;
  const run = tidy.pending ? null : tidy.run;
  const count = plan?.count ?? 0;
  const canOpen = plan === null || run !== null || count > 0;
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
                {count > 0 || !run ? 'Tidy' : runLabel(run)}
                {count > 0 && <span className="ib-pmi-n">{formatCount(count)}</span>}
              </Menu.Item>
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
                </>
              )}
              {look && onLook && (
                <>
                  <Menu.Separator className="ib-pm-sep" />
                  <Menu.Group>
                    <Menu.GroupLabel className="ib-pm-glabel">Rows</Menu.GroupLabel>
                    {LIST_LOOK_OPTIONS.map((option) => (
                      <MenuCheckbox key={option.key} label={option.label} checked={look[option.key]} onChange={(on) => onLook(option.key, on)} data-list-look={option.key} />
                    ))}
                    {onCustomize && (
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

function combineGroups(pairs: readonly InboxTidyCombine[]) {
  const groups = new Map<string, { into: InboxTidyCombine['into']; name: string; pairs: InboxTidyCombine[] }>();
  for (const pair of pairs) {
    const group = groups.get(pair.into.id) ?? { into: pair.into, name: shortProjectNames([pair.into]).get(pair.into.id) ?? pair.into.name, pairs: [] };
    group.pairs.push(pair);
    groups.set(pair.into.id, group);
  }
  return [...groups.values()];
}

function TidyPanel({ tidy: given, onDone }: { tidy: TidyController; onDone: () => void }) {
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
                <HostMark host={agent.host} agent={agent.session} />
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
            <HostMark host={agent.host} agent={agent.session} />
            <span className="ib-tidy-nm">{agent.name}</span>
            <em>{runState(agent)}</em>
          </li>
        ))}
      </ul>
    </>
  );
}

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
