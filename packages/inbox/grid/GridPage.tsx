/**
 * Grid (approval "inbox-agent-grid", round 3; experimental, off by default: Settings → Capabilities → Experimental):
 * one page of every agent's work, this computer's and every linked computer's, grouped Needs you, Moving, Not moving,
 * Landed, Not started and Dropped, with a first line of plain counts and the Since line.
 *
 * Off, nothing of it runs: no row in the sidebar, no read, no timer; a `#grid` address goes to the Inbox. On, it
 * draws from the list the window already holds and the agents it already knows; the only reads are the PRs of the
 * threads that have one (gridPulls.ts). It draws again when the list or the agents change, when a PR read lands, and
 * once a minute while the tab shows (the bars and the times move with the clock).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GRID_GROUPS, GRID_HOUR, gridLandedWord, gridModel, type GridGroup, type GridLine } from '../../shared/inbox/grid';
import { useListModel } from '../data/queries/list';
import { useInboxAgents } from '../agentsList';
import { useSessionLabels } from '../sessionLabels';
import { machinesModel } from '../machines';
import { writeRoute } from '../app/writeRoute';
import { tabShown } from '../data/shownPoll';
import { SidebarTrigger } from '../shell/sidebar';
import { Icon } from '../icons';
import { gridPullThreads, gridRows, gridThreads } from './gridInput';
import { useGridPulls } from './gridPulls';
import { readGridLook, writeGridLook } from './gridLook';
import { GridLineView, type GridClock } from './GridLine';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = (ms: number) => DAYS[new Date(ms).getDay()]!;
/** More than this many lines in Landed, Not started or Dropped: the rest behind "N more". */
const CAP: Partial<Record<GridGroup, number>> = { land: 5, plan: 3, drop: 5 };

/** The minute: the page's clock moves once a minute while the tab shows. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => tabShown() && setNow(Date.now());
    const timer = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return now;
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
  const now = useMinute();
  // The last look this sitting compares with; the page writes its own look as it shows (gridLook.ts).
  const [look] = useState(readGridLook);
  useEffect(() => writeGridLook(now), [now]);
  const [tapped, setTapped] = useState<string | null>(null);
  const [more, setMore] = useState<ReadonlySet<GridGroup>>(() => new Set());
  const [earlierOpen, setEarlierOpen] = useState(false);
  const sections = list?.sections ?? null;
  const machines = useMemo(() => machinesModel(list?.machines), [list?.machines]);
  const wanted = useMemo(() => (sections ? gridPullThreads(gridRows(sections)) : []), [sections]);
  const pulls = useGridPulls(wanted);
  const pullsKey = [...pulls.values()].map((p) => p.map((x) => `${x.pull}${x.state}${x.checks}${x.review}${x.read_at}`).join()).join('|');
  const model = useMemo(
    () => (sections ? gridModel(gridThreads({ sections, groups, machines, labels, pulls }), now, look) : null),
    // `pullsKey` says what the reads brought.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections, groups, machines, labels, pullsKey, now, look],
  );
  const clock = useMemo<GridClock>(() => ({ from: model?.span.from ?? now - 6 * GRID_HOUR, to: now, at: (ms) => (now - ms >= 20 * GRID_HOUR ? `${day(ms)} ` : '') + hm(ms) }), [model?.span.from, now]);
  const onTap = useCallback((id: string) => setTapped((was) => (was === id ? null : id)), []);
  const landed = `landed ${gridLandedWord(new Date(now).getHours())}`;

  const counts = model
    ? GRID_GROUPS.filter((g) => g.id !== 'plan' && model.counts[g.id] > 0).map((g) => ({
        id: g.id,
        words: g.id === 'you' ? `${model.counts.you} ${model.counts.you === 1 ? 'needs' : 'need'} you` : `${model.counts[g.id]} ${g.id === 'land' ? landed : g.count}`,
      }))
    : [];
  const since = model?.since;
  const sinceWords = since ? [since.merged ? `${since.merged} merged` : '', since.dropped ? `${since.dropped} dropped` : ''].filter(Boolean).join(' · ') : '';
  const ticks: number[] = [];
  // The hours on the clock: a line each, a label every hour (every two past eight hours).
  if (model && !phone) for (let at = Math.ceil(model.span.from / GRID_HOUR) * GRID_HOUR; at < now; at += GRID_HOUR) ticks.push(at);
  const pct = (ms: number) => ((ms - clock.from) / (clock.to - clock.from)) * 100;
  const step = model && model.span.to - model.span.from > 8 * GRID_HOUR ? 2 : 1;
  const computerOf = (line: GridLine) => (line.machine ? (machines.names.get(line.machine) ?? null) : machines.all.length > 0 ? (machines.all.find((m) => m.self)?.name ?? null) : null);
  const lineOf = (line: GridLine) => <GridLineView key={line.id} line={line} clock={clock} phone={phone} computer={computerOf(line)} open={tapped === line.id} onOpen={onOpen} onTap={onTap} />;

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
        <span className="ib-grid-since" data-grid-since={since ? '' : undefined}>
          {since && sinceWords && (
            <>
              <i className="ib-grid-new" />
              <span>Since {clock.at(since.at)}</span>
              <span className="ib-grid-since-w">{sinceWords}</span>
            </>
          )}
        </span>
        {!phone && model && (
          <span className="ib-grid-axis" aria-hidden="true">
            {ticks.map((at) => (new Date(at).getHours() % step === 0 && pct(at) > 6 && pct(at) < 84 ? <span key={at} style={{ left: `${pct(at)}%` }}>{hm(at).replace(':00', '')}</span> : null))}
            {look !== null && since && pct(look) > 0 && <i className="ib-grid-lkd" style={{ left: `${pct(look)}%` }} />}
            <span className="ib-grid-now">now</span>
          </span>
        )}
      </div>
      <div className="ib-grid-list" role="list" aria-label="Work">
        {!phone && model && (
          <span className="ib-grid-vl" aria-hidden="true">
            <span>
              {ticks.map((at) => (pct(at) > 2 ? <i key={at} style={{ left: `${pct(at)}%` }} /> : null))}
              {look !== null && since && pct(look) > 0 && <i className="ib-grid-lk" style={{ left: `${pct(look)}%` }} />}
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
                {id === 'land' ? `Landed ${gridLandedWord(new Date(now).getHours())}` : heading.heading}
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
