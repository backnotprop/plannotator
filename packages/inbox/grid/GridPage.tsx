/**
 * Grid (approval "inbox-agent-grid", round 3; experimental, off by default: Settings → Capabilities → Experimental):
 * one page of every agent's work, this computer's and every linked computer's, grouped Needs you, Moving, Not moving,
 * Landed, Not started and Dropped, with a first line of plain counts and the Since line.
 *
 * Off, nothing of it runs: no row in the sidebar, no read, no write, no timer; a `#grid` address goes to the Inbox.
 * On, it draws from the list the window already holds and the agents it already knows: no read of its own (the PRs'
 * times, checks and review ride the list's rows). It draws again when the list or the agents change, and once a
 * minute while the tab shows (the bars and the times move with the clock). Each thread's line is worked out again only
 * when what Grid reads of it changed (shared/inbox/grid.ts `createGridModel`), and a line that did not change keeps
 * its drawing.
 *
 * A sitting compares with the looks it found when it began (the first look read for each thread), so what it shows
 * bold stays bold while the person reads it; a sitting begins when the page opens, or when the tab shows again after
 * five minutes away. What it shows is sent as seen (gridSeen.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { createGridModel, GRID_GROUPS, GRID_HOUR, gridHourTicks, gridLandedWord, type GridGroup, type GridLine } from '../../shared/inbox/grid';
import { useListModel } from '../data/queries/list';
import { useInboxAgents } from '../agentsList';
import { useSessionLabels } from '../sessionLabels';
import { machinesModel } from '../machines';
import { writeRoute } from '../app/writeRoute';
import { tabShown } from '../data/shownPoll';
import { SidebarTrigger } from '../shell/sidebar';
import { Icon } from '../icons';
import { gridClockOf, gridThreads } from './gridInput';
import { useGridSeen } from './gridSeen';
import { gridShown, useGridOn } from './gridOn';
import { GridLineView, type GridClock } from './GridLine';

export { useGridOn };

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = (ms: number) => DAYS[new Date(ms).getDay()]!;
/** More than this many lines in Landed, Not started or Dropped: the rest behind "N more". */
const CAP: Partial<Record<GridGroup, number>> = { land: 5, plan: 3, drop: 5 };
/** Away this long, the tab starts a new sitting when it shows again. */
const SITTING_GAP_MS = 5 * 60_000;

/** The minute: the page's clock moves once a minute while the tab shows. `sitting` moves when a new sitting begins. */
function useClock(): { now: number; sitting: number } {
  const [now, setNow] = useState(() => Date.now());
  const [sitting, setSitting] = useState(0);
  useEffect(() => {
    let hiddenAt: number | null = null;
    const tick = () => tabShown() && setNow(Date.now());
    const timer = setInterval(tick, 60_000);
    const shown = () => {
      if (!tabShown()) {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt >= SITTING_GAP_MS) setSitting((n) => n + 1);
      hiddenAt = null;
      tick();
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, []);
  return { now, sitting };
}

export function GridRoute({ on, settingsKnown, phone, onOpen }: { on: boolean; settingsKnown: boolean; phone: boolean; onOpen: (thread: string) => void }) {
  useEffect(() => {
    if (settingsKnown && !on) writeRoute({ page: 'inbox', project: null, thread: null }, { replace: true });
  }, [settingsKnown, on]);
  if (!on) return <section className="ib-dpage" aria-busy={!settingsKnown || undefined} data-grid-waiting="" />;
  return <GridPage phone={phone} onOpen={onOpen} />;
}

function GridPage({ phone, onOpen }: { phone: boolean; onOpen: (thread: string) => void }) {
  const list = useListModel(useQueryClient());
  const groups = useInboxAgents();
  const labels = useSessionLabels();
  const { now, sitting } = useClock();
  useEffect(() => {
    gridShown(true);
    return () => gridShown(false);
  }, []);
  // The looks this sitting compares with: the first read for each thread.
  const looks = useMemo(() => new Map<string, InboxListRow['grid_seen'] | undefined>(), [sitting]);
  const seenOf = useCallback(
    (row: InboxListRow) => {
      if (!looks.has(row.thread_id)) looks.set(row.thread_id, row.grid_seen);
      return looks.get(row.thread_id);
    },
    [looks],
  );
  const derive = useMemo(() => createGridModel(), []);
  const [tapped, setTapped] = useState<string | null>(null);
  const [more, setMore] = useState<ReadonlySet<GridGroup>>(() => new Set());
  const [earlierOpen, setEarlierOpen] = useState(false);
  const sections = list?.sections ?? null;
  const machines = useMemo(() => machinesModel(list?.machines), [list?.machines]);
  const model = useMemo(() => (sections ? derive(gridThreads({ sections, groups, machines, labels, seenOf }), now) : null), [derive, sections, groups, machines, labels, seenOf, now]);
  const clockOf = useCallback((machine: string | null) => gridClockOf(machine, machines), [machines]);
  const seen = useGridSeen(model, clockOf);
  // The window's open is a new function on each of its draws: the lines keep one, so they draw only when they change.
  const opener = useRef(onOpen);
  opener.current = onOpen;
  const open = useCallback((thread: string) => opener.current(thread), []);
  const clock = useMemo<GridClock>(() => ({ from: model?.span.from ?? now - 6 * GRID_HOUR, to: now, at: (ms) => (now - ms >= 20 * GRID_HOUR ? `${day(ms)} ` : '') + hm(ms) }), [model?.span.from, now]);
  const onTap = useCallback((id: string) => setTapped((was) => (was === id ? null : id)), []);
  const landedLines = model?.groups.find((g) => g.id === 'land')?.lines ?? [];
  const landedWord = gridLandedWord(
    landedLines.map((l) => l.merged!),
    now,
    -new Date(now).getTimezoneOffset(),
  );
  const landed = landedWord ? `landed ${landedWord}` : 'landed';

  const counts = model
    ? GRID_GROUPS.filter((g) => g.id !== 'plan' && model.counts[g.id] > 0).map((g) => ({
        id: g.id,
        words: g.id === 'you' ? `${model.counts.you} ${model.counts.you === 1 ? 'needs' : 'need'} you` : `${model.counts[g.id]} ${g.id === 'land' ? landed : g.count}`,
      }))
    : [];
  const since = model?.since;
  const sinceWords = since ? [since.merged ? `${since.merged} merged` : '', since.dropped ? `${since.dropped} dropped` : ''].filter(Boolean).join(' · ') : '';
  // The hours on the clock, local time: a line each, a label every hour (every two past eight hours).
  const ticks = model && !phone ? gridHourTicks(model.span.from, now) : [];
  const pct = (ms: number) => ((ms - clock.from) / (clock.to - clock.from)) * 100;
  const step = model && model.span.to - model.span.from > 8 * GRID_HOUR ? 2 : 1;
  const look = since?.at ?? null;
  const computerOf = (line: GridLine) => (line.machine ? (machines.names.get(line.machine) ?? null) : machines.all.length > 0 ? (machines.all.find((m) => m.self)?.name ?? null) : null);
  const lineOf = (line: GridLine) => <GridLineView key={line.id} line={line} clock={clock} phone={phone} computer={computerOf(line)} open={tapped === line.id} onOpen={open} onTap={onTap} observe={seen.line} />;

  return (
    <section className="ib-dpage ib-grid" aria-label="Grid" data-grid-page="" data-phone={phone ? '' : undefined}>
      <div className="ib-dh ib-grid-h">
        <SidebarTrigger />
        <h1 tabIndex={-1}>Grid</h1>
        {!phone && <GridCounts counts={counts} />}
        <span className="ib-grid-clock">{`${day(now)} ${hm(now)}`}</span>
      </div>
      {phone && <GridCounts counts={counts} />}
      <div className="ib-grid-ax">
        {since && sinceWords ? (
          <span className="ib-grid-since" data-grid-since="" ref={seen.since}>
            <i className="ib-grid-new" />
            <span>Since {clock.at(since.at)}</span>
            <span className="ib-grid-since-w">{sinceWords}</span>
          </span>
        ) : (
          <span className="ib-grid-since" />
        )}
        {!phone && model && (
          <span className="ib-grid-axis" aria-hidden="true">
            {ticks.map((at) => (new Date(at).getHours() % step === 0 && pct(at) > 6 && pct(at) < 84 ? <span key={at} style={{ left: `${pct(at)}%` }} data-odd={new Date(at).getHours() % 2 ? '' : undefined}>{hm(at).replace(':00', '')}</span> : null))}
            {look !== null && pct(look) > 0 && <i className="ib-grid-lkd" style={{ left: `${pct(look)}%` }} />}
            <span className="ib-grid-now">now</span>
          </span>
        )}
      </div>
      <div className="ib-grid-list" role="list" aria-label="Work">
        {!phone && model && (
          <span className="ib-grid-vl" aria-hidden="true">
            <span>
              {ticks.map((at) => (pct(at) > 2 ? <i key={at} style={{ left: `${pct(at)}%` }} /> : null))}
              {look !== null && pct(look) > 0 && <i className="ib-grid-lk" style={{ left: `${pct(look)}%` }} />}
              <i className="ib-grid-nowl" />
            </span>
          </span>
        )}
        {model?.groups.map(({ id, lines }) => {
          const heading = GRID_GROUPS.find((g) => g.id === id)!;
          const cap = CAP[id];
          const cut = cap !== undefined && lines.length > cap + 1 && !more.has(id) ? cap : lines.length;
          return (
            <div key={id} role="presentation" className="ib-grid-group" data-grid-group={id}>
              <h2 className="ib-grid-gh" data-you={id === 'you' ? '' : undefined}>
                {id === 'land' && landedWord ? `Landed ${landedWord}` : heading.heading}
                <span className="ib-grid-n">{lines.length}</span>
              </h2>
              {lines.slice(0, cut).map(lineOf)}
              {cut < lines.length && (
                <button type="button" className="ib-grid-door" onClick={() => setMore((was) => new Set([...was, id]))}>
                  {lines.length - cut} more <Icon name="chevR" />
                </button>
              )}
            </div>
          );
        })}
        {model && model.groups.length === 0 && <p className="ib-grid-empty">No agent work in flight.</p>}
      </div>
      {model && model.earlier.length > 0 && (
        <div className="ib-grid-earlier" data-grid-earlier="">
          <button type="button" className="ib-grid-door" aria-expanded={earlierOpen} onClick={() => setEarlierOpen((was) => !was)}>
            Earlier <Icon name={earlierOpen ? 'chevD' : 'chevR'} />
          </button>
          {earlierOpen && (
            <div className="ib-grid-list" role="list" aria-label="Earlier">
              {model.earlier.map(lineOf)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function GridCounts({ counts }: { counts: { id: GridGroup; words: string }[] }) {
  if (counts.length === 0) return null;
  return (
    <p className="ib-grid-ans" data-grid-counts="">
      {counts.map((c, i) => (
        <span key={c.id} className="ib-grid-a" data-you={c.id === 'you' ? '' : undefined}>
          {i > 0 && <i className="ib-grid-dot">·</i>}
          {c.words}
        </span>
      ))}
    </p>
  );
}
