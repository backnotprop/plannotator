import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import type { InboxTidyPlan, InboxTidyRun, InboxTidyRunAgent } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { formatCount } from '../format';
import { HostMark, Icon } from '../icons';
import { Tip } from './Tip';

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
}

/** How long the window polls a run's progress. */
const TIDY_POLL_MS = 10 * 60_000;

/** Reads who Tidy would ask in `scope` again whenever `version` changes (a list or Board read), and every few seconds while a run is under way. */
export function useTidy(scope: string | null, surface: TidySurface, version: unknown, enabled = true): TidyController {
  const [plan, setPlan] = useState<InboxTidyPlan | null>(null);
  const seq = useRef(0);
  const refresh = useCallback(() => {
    const mine = ++seq.current;
    inboxApi
      .tidy(scope, surface)
      .then((next) => {
        if (mine === seq.current) setPlan(next);
      })
      .catch(() => {});
  }, [scope, surface]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(refresh, 250);
    return () => clearTimeout(timer);
  }, [refresh, version, enabled]);
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
  return { surface, scope, plan, run, start, refresh };
}


/** "Tidy · 3/4" while a run shows. */
const runLabel = (run: InboxTidyRun) => `Tidy · ${run.done}/${run.agents.length}`;

/**
 * The header's ⋮: Tidy (with its count, or the run's progress) and Refresh.
 * `className` places it in its header (the list's or the Board's).
 */
export function TidyMenu({ tidy, phone, onRefresh, className }: { tidy: TidyController; phone: boolean; onRefresh: () => void; className: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const { plan, run } = tidy;
  const count = plan?.count ?? 0;
  // Still reading (plan null): enabled, so the menu does not flash disabled on load.
  const canOpen = plan === null || run !== null || count > 0;
  return (
    <>
      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <Menu.Trigger ref={trigger} className={`ib-tidytrig ${className}`} aria-label="More" data-tidy-menu="" data-open={popOpen ? '' : undefined}>
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

/** The last run (when there is one), then the picker when there is something to ask. */
function TidyPanel({ tidy, onDone }: { tidy: TidyController; onDone: () => void }) {
  const { plan, run } = tidy;
  const offered = (plan?.agents.length ?? 0) > 0;
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
  if (plan.agents.length === 0)
    return (
      <div className="ib-tidy-top" data-tidy-empty="">
        <b>Tidy</b>
        <span>Nothing to ask</span>
      </div>
    );
  const agents = plan.agents;
  const picked = agents.filter((a) => !off.has(a.session));
  const allThreads = agents.every((a) => a.items.every((i) => i.thread_id !== null));
  return (
    <>
      <div className="ib-tidy-top" data-below={below ? '' : undefined}>
        <b>Tidy</b>
        <span>{plural(plan.count, allThreads ? 'thread' : 'item')}</span>
      </div>
      <ul className="ib-tidy-ags">
        {agents.map((agent) => (
          <li key={agent.session}>
            <label className="ib-tidy-ag" data-tidy-agent={agent.session}>
              <input
                type="checkbox"
                checked={!off.has(agent.session)}
                onChange={(event) =>
                  setOff((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.delete(agent.session);
                    else next.add(agent.session);
                    return next;
                  })
                }
              />
              <HostMark host={agent.host} />
              <span className="ib-tidy-nm">{agent.name}</span>
              <em>{formatCount(agent.items.length)}</em>
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <p className="ib-tidy-err" role="alert">
          {error}
        </p>
      )}
      <div className="ib-tidy-bot">
        <button
          type="button"
          className="ib-btn ib-pri ib-sm"
          disabled={picked.length === 0 || sending}
          data-tidy-go=""
          onClick={async () => {
            setSending(true);
            const failed = await tidy.start(
              picked.map((a) => a.session),
              key,
            );
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
