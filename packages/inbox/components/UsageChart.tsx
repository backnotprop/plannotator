/**
 * Settings → Usage: this Inbox's threads hour by hour (usageChart.ts has the
 * pure half). One row per thread in the order threads began, a mark for each
 * hour with messages, the day labels on top. Self-contained, so moving it out
 * of Settings is one render elsewhere: give it the projects, the project to
 * start on and what opening a thread does.
 *
 * It fits the space like a contribution graph: each hour gets an equal share
 * of the width, and a range that would make the hours too narrow scrolls
 * sideways, opened at the latest hour. Hover (or a tap) shows the thread's
 * name, that hour's and that day's counts and its dates; a click (a second tap
 * on a phone) opens the thread. With the chart focused, the arrow keys move
 * between marks and Enter opens one: a focused-widget pattern, no global key.
 *
 * Drawn as one SVG with a handful of paths whatever the thread count (every
 * mark of a kind in one path) plus one hit test on the pointer, so hundreds of
 * threads and thousands of hours stay a few nodes. Colours are the theme's:
 * the accent mixed toward the page's surface (inbox.css, `.ib-usage`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import type { InboxUsageModel } from '@plannotator/core/inbox-types';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { inboxApi, type ProjectFolder } from '../api';
import { fitUsageInk, usageInkStyle, type UsageInk } from '../usageInk';
import { ProjectFilter } from '../board/ProjectFilter';
import {
  HOUR_MS,
  USAGE_RANGES,
  USAGE_RANGE_LABEL,
  USAGE_STEPS,
  USAGE_TOP,
  defaultUsageRange,
  usageDayCount,
  usageDays,
  usageHit,
  usageLayout,
  usageLookOf,
  usageMove,
  usagePaths,
  usageRadius,
  usageRows,
  usageSpan,
  usageStart,
  usageTier,
  usageX,
  usageY,
  type UsageAt,
  type UsageLook,
  type UsageRange,
  type UsageRow,
} from '../usageChart';

export interface UsageChartProps {
  /** Projects the filter offers (this Inbox's own). */
  projects: readonly ProjectFolder[];
  /** Names as the person reads them. */
  names: ReadonlyMap<string, string>;
  /** The project to start on (the list's filter when Settings opened), or null for every project. */
  project: string | null;
  phone: boolean;
  /** Read again when this changes (the store's cursor), a moment later so a burst of messages is one read. */
  refreshKey?: number | null;
  onOpenThread: (threadId: string, projectId: string | null) => void;
  /** Tests: the clock. */
  now?: () => Date;
  /** Tests and dev comparison: the look (else `?usage-look=dots` in the address, else blend). */
  look?: UsageLook;
}

const REFRESH_AFTER_MS = 1500;

const dayLabel = (date: Date) => ({
  weekday: date.toLocaleDateString(undefined, { weekday: 'short' }),
  date: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
});
const hourLabel = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric' });
const dateLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

interface TipFacts {
  name: string;
  hour: string;
  count: number;
  dayCount: number;
  dayName: string;
  started: string;
  last: string;
  total: number;
}

function factsOf(row: UsageRow, k: number, fromMs: number, days: ReturnType<typeof usageDays>): TipFacts {
  const hour = row.hours[k]!;
  const start = fromMs + hour * HOUR_MS;
  const { day, count: dayCount } = usageDayCount(row, hour, days);
  return {
    name: row.name?.trim() || 'Untitled thread',
    hour: `${hourLabel(start)}–${hourLabel(start + HOUR_MS)}, ${dateLabel(start)}`,
    count: row.counts[k]!,
    dayCount,
    dayName: day ? dateLabel(day.date.getTime()) : '',
    started: dateLabel(row.startedAt),
    last: dateLabel(row.lastAt),
    total: row.total,
  };
}

/** What a screen reader hears as the keyboard moves: the tooltip, in one line. */
const spoken = (f: TipFacts) => `${f.name}: ${plural(f.count, 'message')}, ${f.hour}. ${plural(f.dayCount, 'message')} that day.`;

export function UsageChart({ projects, names, project: startProject, phone, refreshKey = null, onOpenThread, now = () => new Date(), look: lookProp }: UsageChartProps) {
  const look = useMemo<UsageLook>(() => lookProp ?? usageLookOf(typeof location === 'undefined' ? '' : location.search), [lookProp]);
  const [project, setProject] = useState<string | null>(startProject);
  const [picked, setPicked] = useState<UsageRange | null>(null);
  const [width, setWidth] = useState(0);
  const [model, setModel] = useState<InboxUsageModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const [hover, setHover] = useState<{ at: UsageAt; x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<UsageAt | null>(null);
  /** A tap showed this mark's tooltip; tapping it again opens the thread. */
  const pinned = useRef<UsageAt | null>(null);
  const pointerKind = useRef<string>('mouse');
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const { colorTheme, resolvedMode } = useTheme();
  const [ink, setInk] = useState<UsageInk | null>(null);

  // The width the chart has: every hour gets an equal share of it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The ink for this palette (usageInk.ts), read again when the palette or its mode changes, after the theme's
  // classes are on the page (the provider applies them after this component's effects).
  useEffect(() => {
    const el = section.current;
    if (!el || typeof requestAnimationFrame === 'undefined') return;
    const frame = requestAnimationFrame(() => setInk(fitUsageInk(el, look)));
    return () => cancelAnimationFrame(frame);
  }, [colorTheme, resolvedMode, look]);

  const range: UsageRange | null = picked ?? (width > 0 ? defaultUsageRange(width, look) : null);

  // A live change reads again a moment later (a burst of messages is one read).
  const firstKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === firstKey.current) return;
    const timer = setTimeout(() => setReads((n) => n + 1), REFRESH_AFTER_MS);
    return () => clearTimeout(timer);
  }, [refreshKey]);

  useEffect(() => {
    if (range === null) return;
    let live = true;
    const { from, to } = usageSpan(range, now());
    inboxApi.usage(from, to, project).then(
      (next) => {
        if (!live) return;
        setModel(next);
        setError(null);
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
    // `now` is a clock, not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, project, reads]);

  const from = model ? Date.parse(model.from) : 0;
  const to = model ? Date.parse(model.to) : 0;
  const rows = useMemo(() => (model ? usageRows(model) : []), [model]);
  const days = useMemo(() => (model ? usageDays(new Date(from), new Date(to)) : []), [model, from, to]);
  const layout = useMemo(() => (model && width > 0 ? usageLayout(width, model.hour_count, rows.length, look) : null), [model, width, rows.length, look]);
  const started = useRef(0);
  const paths = useMemo(() => {
    started.current = performance.now();
    return layout ? usagePaths(rows, layout, days) : null;
  }, [rows, layout, days]);

  // Render time (paths + commit), for the perf note and the real-size check: `data-usage-render-ms`.
  useLayoutEffect(() => {
    if (!paths || !box.current) return;
    box.current.dataset.usageRenderMs = (performance.now() - started.current).toFixed(1);
  }, [paths]);

  // A chart wider than the space opens at the latest hour.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && layout?.scrolls) el.scrollLeft = el.scrollWidth;
  }, [layout?.scrolls, layout?.width, model]);

  // A new read can drop the mark the keyboard or a tap was on.
  useEffect(() => {
    setHover(null);
    pinned.current = null;
    setCursor((at) => (at && rows[at.row] && at.k < rows[at.row]!.hours.length ? at : null));
  }, [rows]);

  const shown: UsageAt | null = hover?.at ?? cursor;
  const facts = shown && rows[shown.row] ? factsOf(rows[shown.row]!, shown.k, from, days) : null;

  // The tooltip beside the pointer, or beside the mark the keyboard is on; kept inside the window.
  useLayoutEffect(() => {
    const el = tip.current;
    if (!el || !facts || !layout || !svg.current) return;
    let x: number;
    let y: number;
    if (hover) {
      x = hover.x;
      y = hover.y;
    } else {
      const rect = svg.current.getBoundingClientRect();
      x = rect.left + usageX(layout, rows[shown!.row]!.hours[shown!.k]!);
      y = rect.top + usageY(layout, shown!.row);
    }
    const b = el.getBoundingClientRect();
    let left = x + 14;
    let top = y + 14;
    if (left + b.width > window.innerWidth - 8) left = x - b.width - 14;
    if (left < 8) left = 8;
    if (top + b.height > window.innerHeight - 8) top = y - b.height - 14;
    if (top < 8) top = 8;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  });

  const point = (event: PointerEvent<SVGSVGElement>): UsageAt | null => {
    if (!layout || !svg.current) return null;
    const rect = svg.current.getBoundingClientRect();
    return usageHit(rows, layout, event.clientX - rect.left, event.clientY - rect.top);
  };

  const open = useCallback((at: UsageAt) => {
    const row = rows[at.row];
    if (row) onOpenThread(row.id, project);
  }, [rows, onOpenThread, project]);

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    pointerKind.current = event.pointerType;
    if (event.pointerType !== 'mouse' && event.type === 'pointermove') return;
    const at = point(event);
    setHover(at ? { at, x: event.clientX, y: event.clientY } : null);
  };

  const onClick = (event: MouseEvent<SVGSVGElement>) => {
    if (!layout || !svg.current) return;
    const rect = svg.current.getBoundingClientRect();
    const at = usageHit(rows, layout, event.clientX - rect.left, event.clientY - rect.top);
    if (!at) {
      pinned.current = null;
      return;
    }
    // On a touch screen the first tap shows the tooltip; a second tap on the same mark opens it.
    if (pointerKind.current !== 'mouse') {
      const was = pinned.current;
      if (!was || was.row !== at.row || was.k !== at.k) {
        pinned.current = at;
        setHover({ at, x: event.clientX, y: event.clientY });
        return;
      }
    }
    open(at);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Enter' || event.key === ' ') {
      if (!cursor) return;
      event.preventDefault();
      event.stopPropagation();
      open(cursor);
      return;
    }
    if (event.key === 'Escape') {
      // The first Escape lets go of the mark; the next one is Settings' own (back to the Inbox).
      if (!cursor) return;
      event.preventDefault();
      setCursor(null);
      return;
    }
    const from = cursor ?? usageStart(rows);
    if (!from) return;
    const next = cursor ? usageMove(rows, cursor, event.key) : ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) ? from : null;
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    setHover(null);
    setCursor(next);
  };

  // The mark the keyboard is on stays in view.
  useEffect(() => {
    if (cursor) ring.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [cursor]);

  const total = useMemo(() => rows.reduce((sum, row) => sum + row.counts.reduce((a, b) => a + b, 0), 0), [rows]);
  const label = project ? (names.get(project) ?? 'this project') : 'every project';

  const ringAt = shown && layout && rows[shown.row] ? { x: usageX(layout, rows[shown.row]!.hours[shown.k]!), y: usageY(layout, shown.row), r: (layout.look === 'blend' ? usageRadius(rows[shown.row]!.counts[shown.k]!, layout) : layout.rMin) + 2.5 } : null;

  return (
    <section ref={section} className="ib-sgroup ib-usage" data-usage="" data-usage-look={look} aria-label="Usage" style={ink ? (usageInkStyle(ink) as CSSProperties) : undefined} data-usage-ink={ink?.ink}>
      <div className="ib-usage-bar">
        <span className="ib-seg" role="radiogroup" aria-label="Range">
          {USAGE_RANGES.filter((days) => !phone || days <= 7).map((days) => (
            <label key={days} className="ib-seg-o" data-on={range === days ? '' : undefined}>
              <input type="radio" name="ib-usage-range" value={days} checked={range === days} onChange={() => setPicked(days)} />
              {USAGE_RANGE_LABEL[days]}
            </label>
          ))}
        </span>
        {projects.length > 1 && <ProjectFilter projects={projects} names={names} value={project} phone={phone} onChange={setProject} />}
        {model && (
          <span className="ib-usage-sum" data-usage-summary="">
            {plural(rows.length, 'thread')}, {plural(total, 'message')}
          </span>
        )}
      </div>
      <div className="ib-usage-box" ref={box}>
        {error ? (
          <p className="ib-usage-note" role="alert">
            Usage could not be read. {error}{' '}
            <button type="button" className="ib-lnk" onClick={() => setReads((n) => n + 1)}>
              Try again
            </button>
          </p>
        ) : model && rows.length === 0 ? (
          <p className="ib-usage-note" data-usage-empty="">
            No messages in {label} {range === 1 ? 'today' : `in the last ${range} days`}.
          </p>
        ) : layout && paths ? (
          <div
            className="ib-usage-scroll"
            ref={scroller}
            data-scrolls={layout.scrolls ? '' : undefined}
            tabIndex={0}
            role="group"
            aria-roledescription="chart"
            aria-label={`Threads in ${label} hour by hour, one row per thread in the order they began. Arrow keys move between hours with messages; Enter opens the thread.`}
            onKeyDown={onKeyDown}
            onBlur={() => setCursor(null)}
            onScroll={() => setHover(null)}
          >
            <div className="ib-usage-days" style={{ width: layout.width, height: USAGE_TOP } as CSSProperties} aria-hidden="true">
              {days.map((day) => {
                const text = dayLabel(day.date);
                return (
                  <span key={day.col} className="ib-usage-day" style={{ left: day.col * layout.cell, width: day.hours * layout.cell }}>
                    <span className="ib-usage-wd">{text.weekday}</span>
                    <span className="ib-usage-dt">{text.date}</span>
                  </span>
                );
              })}
            </div>
            <svg
              ref={svg}
              className="ib-usage-svg"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              aria-hidden="true"
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={(event) => event.pointerType === 'mouse' && setHover(null)}
              onClick={onClick}
              data-marks={paths.marks}
              style={{ cursor: hover ? 'pointer' : undefined }}
            >
              <path className="ib-usage-dline" d={paths.days} />
              {shown && layout && <rect className="ib-usage-band" x={0} y={USAGE_TOP + shown.row * layout.pitch} width={layout.width} height={layout.pitch} rx={3} />}
              {look === 'blend' ? (
                <>
                  <path className="ib-usage-strand" d={paths.strands} />
                  {paths.tiers.map((d, i) => (
                    <path key={i} className={`ib-usage-t${i}`} d={d} />
                  ))}
                </>
              ) : (
                paths.steps.map((d, i) => <path key={i} className={`ib-usage-s${i}`} d={d} />)
              )}
              {ringAt && <circle ref={ring} className="ib-usage-ring" cx={ringAt.x} cy={ringAt.y} r={ringAt.r} data-usage-ring="" />}
            </svg>
          </div>
        ) : (
          <div className="ib-usage-wait" aria-busy="true" />
        )}
      </div>
      {layout && rows.length > 0 && (
        <div className="ib-usage-key" aria-hidden="true">
          <span>1</span>
          <svg width={USAGE_STEPS.length * 16} height={16} viewBox={`0 0 ${USAGE_STEPS.length * 16} 16`}>
            {USAGE_STEPS.map((count, i) =>
              look === 'blend' ? (
                <circle key={count} className={`ib-usage-t${usageTier(count)}`} cx={8 + i * 16} cy={8} r={usageRadius(count, { rMin: 1.75, rMax: 6.5 })} />
              ) : (
                <circle key={count} className={`ib-usage-s${i}`} cx={8 + i * 16} cy={8} r={3} />
              ),
            )}
          </svg>
          <span>10+ messages an hour</span>
        </div>
      )}
      <div className="ib-sr" aria-live="polite" data-usage-live="">
        {cursor && facts ? spoken(facts) : ''}
      </div>
      {facts && (
        <div className="ib-usage-tip" ref={tip} role="tooltip" data-usage-tip="">
          <div className="ib-usage-tip-n" dir="auto">
            {facts.name}
          </div>
          <div className="ib-usage-tip-v">
            <b>{plural(facts.count, 'message')}</b> {facts.hour}
          </div>
          <div className="ib-usage-tip-v">
            <b>{plural(facts.dayCount, 'message')}</b> that day
          </div>
          <div className="ib-usage-tip-m">
            Started {facts.started}, last message {facts.last}, {plural(facts.total, 'message')} in all
          </div>
          {pointerKind.current !== 'mouse' && hover && <div className="ib-usage-tip-m">Tap again to open</div>}
        </div>
      )}
    </section>
  );
}
