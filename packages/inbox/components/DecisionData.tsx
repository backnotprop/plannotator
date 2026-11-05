/**
 * Settings -> Decision data (approval `.product/approved/decision-data/`, 2026-11-05): Ask on top, Insights below.
 * Short labels and numbers, one chart in the product's accent, two tables, a CSV. Only Settings mounts this, and this
 * mount is the only thing that asks the server to count. Ask never waits on the count.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DecisionDataSummary, DecisionGroup, DecisionTrend } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { plural } from '../format';
import { HostMark, Icon } from '../icons';
import { inboxUrl } from '../inboxUrl';
import { DecisionAsk } from './DecisionAsk';

function useDecisionData(days: number) {
  const [model, setModel] = useState<DecisionDataSummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    inboxApi
      .decisionData(days, controller.signal)
      .then(setModel)
      .catch(() => {
        if (controller.signal.aborted) return;
        // Old numbers under a new range would read as that range's: Ask stays, the numbers go.
        setModel(null);
        setFailed(true);
      });
    return () => controller.abort();
  }, [days]);
  return { model, failed };
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function waitWords(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 || hours >= 10 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}
const percent = (part: number, of: number) => `${Math.round((part / of) * 100)}%`;
const dayLabel = (at: number | string) => new Date(typeof at === 'string' ? `${at}T12:00:00` : at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Round numbers for the axis, halves that stay whole. */
export function axisTop(most: number): number {
  for (const top of [2, 4, 6, 10, 20, 40]) if (most <= top) return top;
  return Math.ceil(most / 20) * 20;
}

/** Every how many days a date label fits. Past a few years the steps keep growing, so labels never run together. */
export function labelStep(band: number): number {
  const needed = 54 / Math.max(0.01, band);
  return [1, 2, 7, 14, 28].find((step) => step >= needed) ?? Math.ceil(needed / 28) * 28;
}

/** Columns: one series, 2 px gap, 4 px rounded data-end, square at the baseline. */
function DayColumns({ days, since, until, height }: { days: DecisionDataSummary['days']; since: number; until: number; height: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const series = useMemo(() => {
    const byDay = new Map(days.map((day) => [day.day, day]));
    const out: DecisionDataSummary['days'] = [];
    const first = new Date(since);
    first.setHours(12, 0, 0, 0);
    for (let at = first.getTime(); at <= until + 43_200_000; at += 86_400_000) {
      const local = new Date(at);
      const key = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
      out.push(byDay.get(key) ?? { day: key, answered: 0, skipped: 0, own_words: 0 });
    }
    return out;
  }, [days, since, until]);
  const left = 26;
  const plotWidth = Math.max(0, width - left);
  const band = series.length > 0 ? plotWidth / series.length : 0;
  const barWidth = Math.min(24, Math.max(2, band - 2));
  const most = Math.max(1, ...series.map((day) => day.answered));
  const top = axisTop(most);
  const plotHeight = height - 22;
  const headRoom = 16;
  const y = (value: number) => plotHeight - (value / top) * (plotHeight - headRoom);
  const peak = series.reduce((best, day, index) => (day.answered > (series[best]?.answered ?? 0) ? index : best), 0);
  const step = labelStep(band);
  const shown = hover === null ? null : series[hover];
  return (
    <div className="ib-dd-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Answers per day. Most on ${dayLabel(series[peak]?.day ?? '')}: ${series[peak]?.answered ?? 0}.`}>
          {[0, top / 2, top].map((value) => (
            <g key={value}>
              <line x1={left} x2={width} y1={y(value)} y2={y(value)} className="ib-dd-grid" />
              <text x={left - 6} y={y(value) + 3.5} textAnchor="end" className="ib-dd-axis">
                {value}
              </text>
            </g>
          ))}
          {series.map((day, index) => {
            const x = left + index * band + (band - barWidth) / 2;
            const barTop = y(day.answered);
            const corner = Math.min(4, barWidth / 2);
            const center = left + index * band + band / 2;
            return (
              <g key={day.day}>
                {hover === index && <rect x={left + index * band} y={0} width={band} height={plotHeight} className="ib-dd-band" />}
                {day.answered > 0 && <path d={`M${x},${plotHeight}V${barTop + corner}Q${x},${barTop} ${x + corner},${barTop}H${x + barWidth - corner}Q${x + barWidth},${barTop} ${x + barWidth},${barTop + corner}V${plotHeight}Z`} className="ib-dd-bar" />}
                <rect x={left + index * band} y={0} width={band} height={plotHeight + 18} fill="transparent" onMouseEnter={() => setHover(index)} />
                {index % step === 0 && (
                  <text x={center > width - 22 ? width : center} y={height - 5} textAnchor={center > width - 22 ? 'end' : 'middle'} className="ib-dd-axis">
                    {dayLabel(day.day)}
                  </text>
                )}
              </g>
            );
          })}
          {series[peak] && series[peak]!.answered > 0 && hover === null && (
            <text
              x={Math.min(width - 4, left + peak * band + band / 2)}
              y={y(series[peak]!.answered) - 5}
              textAnchor={left + peak * band + band / 2 > width - 30 ? 'end' : 'middle'}
              className="ib-dd-label"
            >
              {series[peak]!.answered}
            </text>
          )}
        </svg>
      )}
      {shown && hover !== null && (
        <div className="ib-dd-tip" role="status" style={{ left: Math.min(Math.max(0, left + hover * band - 80), Math.max(0, width - 170)), top: 2 }}>
          <b>{dayLabel(shown.day)}</b>
          <span>{plural(shown.answered, 'decision')}</span>
          {shown.skipped > 0 && <span>{shown.skipped} skipped</span>}
          {shown.own_words > 0 && <span>{plural(shown.own_words, 'plain reply', 'plain replies')}</span>}
        </div>
      )}
    </div>
  );
}

function ByDay({ days }: { days: DecisionDataSummary['days'] }) {
  return (
    <details className="ib-dd-byday">
      <summary>See by day</summary>
      <div className="ib-dd-byday-in">
        <table className="ib-dd-tbl">
          <thead>
            <tr>
              <th>Day</th>
              <th className="ib-dd-r">Decisions</th>
              <th className="ib-dd-r">Skipped</th>
              <th className="ib-dd-r">Plain replies</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.day}>
                <td>{dayLabel(day.day)}</td>
                <td className="ib-dd-r">{day.answered}</td>
                <td className="ib-dd-r">{day.skipped}</td>
                <td className="ib-dd-r">{day.own_words}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function GroupRows({ groups, min, kind, narrow }: { groups: DecisionGroup[]; min: number; kind: 'project' | 'agent'; narrow: boolean }) {
  const most = Math.max(1, ...groups.map((group) => group.answered));
  const took = (group: DecisionGroup) => (group.offered >= min ? percent(group.taken, group.offered) : '–');
  const closed = (group: DecisionGroup) => {
    const total = group.answered + group.skipped + group.set_aside;
    return total >= min ? percent(group.skipped + group.set_aside, total) : '–';
  };
  const wait = (group: DecisionGroup) => (group.median_wait_ms === null ? '–' : waitWords(group.median_wait_ms));
  const name = (group: DecisionGroup) => (
    <span className="ib-dd-name" title={group.label}>
      {group.host && <HostMark host={group.host} />}
      <span>{group.label}</span>
    </span>
  );
  const bar = (group: DecisionGroup) => (
    <span className="ib-dd-thin">
      <span style={{ width: `${(group.answered / most) * 100}%` }} />
    </span>
  );
  if (narrow) {
    return (
      <ul className="ib-card ib-dd-gl" data-group={kind}>
        {groups.map((group) => {
          const facts = [took(group) !== '–' ? `Took the recommendation ${took(group)}` : null, closed(group) !== '–' ? `Skipped or closed ${closed(group)}` : null, wait(group) !== '–' ? `Usually waited ${wait(group)}` : null].filter(Boolean);
          return (
            <li key={group.id}>
              <div className="ib-dd-gl-top">
                {name(group)}
                <span className="ib-dd-tnum">{plural(group.answered, 'decision')}</span>
              </div>
              {bar(group)}
              <div className="ib-dd-gl-sub">{facts.join(' · ') || 'Too few for a fair number'}</div>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className="ib-card" data-group={kind}>
      <table className="ib-dd-tbl">
        <thead>
          <tr>
            <th>{kind === 'agent' ? 'Agent' : 'Project'}</th>
            <th className="ib-dd-r">Decisions</th>
            <th className="ib-dd-r">Took recommendation</th>
            <th className="ib-dd-r">Skipped or closed</th>
            <th className="ib-dd-r">Usual wait</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.id}>
              <td className="ib-dd-namecell">
                {name(group)}
                {bar(group)}
              </td>
              <td className="ib-dd-r">{group.answered}</td>
              <td className="ib-dd-r">{took(group)}</td>
              <td className="ib-dd-r">{closed(group)}</td>
              <td className="ib-dd-r">{wait(group)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Meaning() {
  return (
    <details className="ib-dd-meaning" data-decision-meaning="">
      <summary>What counts as a decision</summary>
      <ul>
        <li>
          <b>A decision</b> is a question card you sent, with a choice, your own words on the card, or a typed answer. A quick go-ahead counts the same as a hard call.
        </li>
        <li>
          <b>Plain replies are not counted.</b> "Go with B" can settle something, but nothing stored says what it settled. Ask can still find them.
        </li>
        <li>
          <b>Replaced questions are not decisions.</b> A pick saved on one was never sent. Its replacement counts once you send it.
        </li>
        <li>
          <b>Took the recommendation</b> is exact when the question named one. It can be real agreement; the numbers can't tell.
        </li>
        <li>
          <b>Pace</b> is measured in sittings: 3 or more decisions with under 5 minutes between them. Easy questions are also quick. The reading you did before your first pick is not in it.
        </li>
        <li>
          <b>Trends</b> show only with two full 30-day periods, 20 or more in each, and a change too big to be chance.
        </li>
        <li>
          <b>Waiting</b> runs from when the agent asked to when you sent, nights included. Most agents keep working meanwhile; only a question marked Stopped holds one still.
        </li>
        <li>
          <b>Nothing here says what you read.</b> The Inbox does not record which files you opened.
        </li>
        <li>
          <b>Deleting a thread</b> removes its words, but its line stays in these totals with no words in it. Ask can't read a deleted thread. <code>plannotator uninstall --purge</code> removes the lines too.
        </li>
        <li>All of this is on this computer. Nothing here is sent anywhere.</li>
      </ul>
    </details>
  );
}

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 0, label: 'All' },
];

function Range({ days, onDays }: { days: number; onDays: (days: number) => void }) {
  return (
    <div className="ib-dd-range">
      <span className="ib-seg" role="radiogroup" aria-label="Range">
        {RANGES.map((range) => (
          <label key={range.days} className="ib-seg-o" data-on={days === range.days ? '' : undefined}>
            <input type="radio" name="ib-dd-range" checked={days === range.days} onChange={() => onDays(range.days)} />
            {range.label}
          </label>
        ))}
      </span>
    </div>
  );
}

interface Insight {
  key: string;
  label: string;
  value: ReactNode;
}

/** A line shows only when it has enough behind it. */
export function insightsOf(model: DecisionDataSummary): Insight[] {
  const out: Insight[] = [];
  const share = (part: number, of: number) => (of > 0 ? part / of : 0);
  const byTaken = model.agents.filter((group) => group.offered >= model.rate_min).sort((a, b) => share(b.taken, b.offered) - share(a.taken, a.offered))[0];
  if (byTaken && share(byTaken.taken, byTaken.offered) >= 0.75) {
    out.push({
      key: 'taken',
      label: `Took ${byTaken.label}'s recommendation`,
      value: (
        <>
          <b>{byTaken.taken}</b> of {byTaken.offered}
        </>
      ),
    });
  }
  if (model.stopped_wait.n >= model.median_min) {
    out.push({
      key: 'stopped',
      label: 'Stopped agents waited',
      value: (
        <>
          <b>{waitWords(model.stopped_wait.median_ms!)}</b>, {plural(model.stopped_wait.n, 'time')}
        </>
      ),
    });
  }
  const byReplaced = model.agents.filter((group) => group.replaced >= 5).sort((a, b) => b.replaced - a.replaced)[0];
  if (byReplaced) out.push({ key: 'replaced', label: `${byReplaced.label} replaced before you answered`, value: <b>{byReplaced.replaced}</b> });
  const closedShare = (group: DecisionGroup) => share(group.skipped + group.set_aside, group.answered + group.skipped + group.set_aside);
  const byClosed = model.projects.filter((group) => group.answered + group.skipped + group.set_aside >= model.rate_min).sort((a, b) => closedShare(b) - closedShare(a))[0];
  if (byClosed && closedShare(byClosed) >= 0.15) {
    out.push({ key: 'closed', label: `Skipped or closed in ${byClosed.label}`, value: <b>{percent(byClosed.skipped + byClosed.set_aside, byClosed.answered + byClosed.skipped + byClosed.set_aside)}</b> });
  }
  const { fast, slow } = model.pace;
  if (fast.offered >= model.rate_min && slow.offered >= model.rate_min) {
    out.push({
      key: 'pace',
      label: 'Took the recommendation, by pace',
      value: (
        <>
          <b>{percent(fast.taken, fast.offered)}</b> over 2 a minute, <b>{percent(slow.taken, slow.offered)}</b> under 1
        </>
      ),
    });
  }
  if (model.settled_in_words > 0) {
    out.push({
      key: 'words',
      label: 'Ended in your own words, not on the card',
      value: (
        <>
          about <b>{model.settled_in_words}</b>
        </>
      ),
    });
  }
  return out;
}

const TREND_WORDS = {
  recommendations: { up: 'Taking more recommendations', down: 'Taking fewer recommendations' },
  waits: { up: 'Stopped agents wait longer', down: 'Stopped agents wait less' },
  skips: { up: 'Skipping more questions', down: 'Skipping fewer questions' },
};

/** Up or down is the number's direction, not a verdict: no good or bad colour. No trend, no block. */
function Trends({ trends }: { trends: DecisionTrend[] }) {
  if (trends.length === 0) return null;
  return (
    <div className="ib-dd-trends" data-decision-trends="">
      <p>Last 30 days, compared with the 30 before</p>
      <ul>
        {trends.map((trend) => (
          <li key={trend.key} data-trend={trend.key} data-direction={trend.direction}>
            <span>
              <span className="ib-dd-arrow" aria-hidden="true">
                {trend.direction === 'up' ? '↑' : '↓'}
              </span>
              {TREND_WORDS[trend.key][trend.direction]}
            </span>
            <span>
              {'now_ms' in trend ? (
                <>
                  <b>{waitWords(trend.now_ms)}</b>, was {waitWords(trend.was_ms)}
                </>
              ) : (
                <>
                  <b>{Math.round(trend.now * 100)}%</b>, was {Math.round(trend.was * 100)}%
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Insights({ model, days, onDays, narrow }: { model: DecisionDataSummary; days: number; onDays: (days: number) => void; narrow: boolean }) {
  const started = model.range.earliest ?? model.range.until;
  const { counts } = model;
  const insights = insightsOf(model);
  return (
    <>
      <section className="ib-sgroup" data-decision-insights="">
        <h2>Insights</h2>
        <Trends trends={model.trends} />
        <Range days={days} onDays={onDays} />
        <p data-decision-lede="">
          Since {dayLabel(started)}: <b>{plural(counts.answered, 'decision')}</b>, {counts.skipped} skipped, {counts.set_aside} closed with Mark read, {model.waiting} waiting on you.
        </p>
        {counts.answered + counts.skipped === 0 ? (
          <div className="ib-card ib-sempty" data-decision-filtered="">
            Nothing answered in this range.{' '}
            <button type="button" className="ib-lnk" onClick={() => onDays(0)}>
              Show everything
            </button>
          </div>
        ) : (
          <>
            {insights.length > 0 && (
              <ul className="ib-dd-insights">
                {insights.map((insight) => (
                  <li key={insight.key} data-insight={insight.key}>
                    <span>{insight.label}</span>
                    <span>{insight.value}</span>
                  </li>
                ))}
              </ul>
            )}
            <h3 className="ib-dd-sub">Decisions by day</h3>
            <DayColumns days={model.days} since={started} until={model.range.until} height={130} />
            <ByDay days={model.days} />
            <h3 className="ib-dd-sub">Who asks</h3>
            <GroupRows groups={model.agents} min={model.rate_min} kind="agent" narrow={narrow} />
            <div className="ib-dd-gap" />
            <GroupRows groups={model.projects} min={model.rate_min} kind="project" narrow={narrow} />
            <p className="ib-dd-dash">A dash means too few to give a fair number.</p>
            <div className="ib-dd-foot">
              <a className="ib-lnk" href={inboxUrl('/decision-data', new URLSearchParams({ format: 'csv', days: String(days) }).toString())} data-decision-csv="">
                Download as CSV
              </a>
              <span>One line per question: times and ids, no words.</span>
            </div>
          </>
        )}
      </section>
      <Meaning />
    </>
  );
}

/** Under this the table's number columns leave too little of an ordinary name ("Claud…"), so Who asks is a list. */
const TABLE_MIN_WIDTH = 640;

/** How long the section may stay empty for a count on its way: on a small store the numbers are back first, so the first paint is already right. */
const COUNT_PATIENCE_MS = 150;

export function DecisionData() {
  const [days, setDays] = useState(90);
  const { model, failed } = useDecisionData(days);
  const [patience, setPatience] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setPatience(true), COUNT_PATIENCE_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const [ref, width] = useWidth<HTMLDivElement>();
  const narrow = width > 0 && width < TABLE_MIN_WIDTH;

  let content: ReactNode = null;
  if (failed) content = <DecisionAsk />;
  else if (!model) {
    content = patience ? (
      <>
        <DecisionAsk />
        <div className="ib-skel" aria-hidden="true" data-decision-counting="" />
      </>
    ) : null;
  } else if (model.history.asked === 0 && model.waiting === 0) {
    content = (
      <div className="ib-card ib-sempty" data-decision-empty="">
        <Icon name="inbox" />
        No decisions yet.
      </div>
    );
  } else {
    const ageDays = model.history.earliest ? (model.range.until - model.history.earliest) / 86_400_000 : 0;
    content = (
      <>
        <DecisionAsk />
        {model.history.answered < 20 && ageDays < 7 ? (
          <>
            <p className="ib-lede" data-decision-lede="">
              So far: <b>{plural(model.counts.answered, 'decision')}</b>
              {model.counts.skipped > 0 ? `, ${model.counts.skipped} skipped` : ''}.
              {model.waiting > 0 && (
                <>
                  {' '}
                  {model.waiting} {model.waiting === 1 ? 'waits' : 'wait'} on you now.
                </>
              )}
            </p>
            <div className="ib-card ib-sempty" data-decision-early="">
              <Icon name="clock" />
              Insights show after about a week, or 20 decisions.
            </div>
          </>
        ) : (
          <Insights model={model} days={days} onDays={setDays} narrow={narrow} />
        )}
      </>
    );
  }
  return (
    <div ref={ref} className="ib-dd" data-decision-data="">
      {content}
    </div>
  );
}
