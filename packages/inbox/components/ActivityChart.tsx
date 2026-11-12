import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import type { InboxActivityModel } from '@plannotator/core/inbox-types';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { inboxApi, type ProjectFolder } from '../api';
import { fitActivityInk, activityInkStyle, type ActivityInk } from '../activityInk';
import { ProjectFilter } from '../board/ProjectFilter';
import { Icon } from '../icons';
import { Modal } from './Updates';
import {
  HOUR_MS,
  ACTIVITY_RANGES,
  ACTIVITY_RANGE_LABEL,
  ACTIVITY_STEPS,
  defaultActivityRange,
  activityDayCount,
  activityDays,
  activityHit,
  activityLayout,
  activityLookOf,
  activityPaths,
  activityRadius,
  activityRows,
  activitySpan,
  activityTier,
  activityX,
  activityY,
  type ActivityAt,
  type ActivityDay,
  type ActivityLook,
  type ActivityRange,
  type ActivityRow,
  type ActivitySize,
} from '../activityChart';

export interface ActivityChartProps {
  projects: readonly ProjectFolder[];
  names: ReadonlyMap<string, string>;
  project: string | null;
  phone: boolean;
  refreshKey?: number | null;
  onOpenThread: (threadId: string, projectId: string | null) => void;
  now?: () => Date;
  look?: ActivityLook;
}

const REFRESH_AFTER_MS = 1500;

const hourLabel = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric' });
const dateLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const rangeWords = (range: ActivityRange) => (range === 1 ? 'today' : range === 7 ? 'this week' : `in the last ${range} days`);

interface TipFacts {
  name: string;
  hour: string;
  count: number;
  dayCount: number;
  started: string;
  last: string;
  total: number;
}

function factsOf(row: ActivityRow, k: number, fromMs: number, days: readonly ActivityDay[]): TipFacts {
  const hour = row.hours[k]!;
  const start = fromMs + hour * HOUR_MS;
  return {
    name: row.name?.trim() || 'Untitled thread',
    hour: `${hourLabel(start)}–${hourLabel(start + HOUR_MS)}, ${dateLabel(start)}`,
    count: row.counts[k]!,
    dayCount: activityDayCount(row, hour, days).count,
    started: dateLabel(row.startedAt),
    last: dateLabel(row.lastAt),
    total: row.total,
  };
}

function useBox<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox((was) => (was.width === Math.floor(el.clientWidth) && was.height === Math.floor(el.clientHeight) ? was : { width: Math.floor(el.clientWidth), height: Math.floor(el.clientHeight) }));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, box];
}

interface PlotProps {
  size: ActivitySize;
  rows: readonly ActivityRow[];
  days: readonly ActivityDay[];
  model: InboxActivityModel;
  look: ActivityLook;
  width: number;
  height?: number;
  onOpen?: (row: ActivityRow) => void;
}

function ActivityPlot({ size, rows, days, model, look, width, height, onOpen }: PlotProps) {
  const from = Date.parse(model.from);
  const layout = useMemo(() => activityLayout(width, model.hour_count, rows.length, look, size, height), [width, model.hour_count, rows.length, look, size, height]);
  const started = useRef(0);
  const paths = useMemo(() => {
    started.current = performance.now();
    return activityPaths(rows, layout, days);
  }, [rows, layout, days]);
  const plot = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ at: ActivityAt; x: number; y: number } | null>(null);
  const pinned = useRef<ActivityAt | null>(null);
  const pointerKind = useRef<string>('mouse');
  const interactive = size === 'full' && !!onOpen;

  useLayoutEffect(() => {
    if (plot.current) plot.current.dataset.activityRenderMs = (performance.now() - started.current).toFixed(1);
  }, [paths]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && layout.scrolls) el.scrollLeft = el.scrollWidth;
  }, [layout.scrolls, layout.width, model]);

  useEffect(() => {
    setHover(null);
    pinned.current = null;
  }, [rows]);

  const facts = hover && rows[hover.at.row] ? factsOf(rows[hover.at.row]!, hover.at.k, from, days) : null;

  useLayoutEffect(() => {
    const el = tip.current;
    if (!el || !hover) return;
    const b = el.getBoundingClientRect();
    let left = hover.x + 14;
    let top = hover.y + 14;
    if (left + b.width > window.innerWidth - 8) left = hover.x - b.width - 14;
    if (left < 8) left = 8;
    if (top + b.height > window.innerHeight - 8) top = hover.y - b.height - 14;
    if (top < 8) top = 8;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  });

  const hit = (clientX: number, clientY: number): ActivityAt | null => {
    if (!svg.current) return null;
    const rect = svg.current.getBoundingClientRect();
    return activityHit(rows, layout, clientX - rect.left, clientY - rect.top);
  };

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    pointerKind.current = event.pointerType;
    if (event.pointerType !== 'mouse' && event.type === 'pointermove') return;
    const at = hit(event.clientX, event.clientY);
    setHover(at ? { at, x: event.clientX, y: event.clientY } : null);
  };

  const onClick = (event: MouseEvent<SVGSVGElement>) => {
    const at = hit(event.clientX, event.clientY);
    if (!at) {
      pinned.current = null;
      setHover(null);
      return;
    }
    if (pointerKind.current !== 'mouse') {
      const was = pinned.current;
      if (!was || was.row !== at.row || was.k !== at.k) {
        pinned.current = at;
        setHover({ at, x: event.clientX, y: event.clientY });
        return;
      }
    }
    onOpen?.(rows[at.row]!);
  };

  const shown = hover?.at ?? null;
  const ring = shown && rows[shown.row] ? { x: activityX(layout, rows[shown.row]!.hours[shown.k]!), y: activityY(layout, shown.row), r: (look === 'blend' ? activityRadius(rows[shown.row]!.counts[shown.k]!, layout) : layout.rMin) + 2.5 } : null;

  return (
    <div className="ib-activity-plot" ref={plot} data-size={size}>
      <div className="ib-activity-scroll" ref={scroller} data-scrolls={layout.scrolls ? '' : undefined} onScroll={() => setHover(null)}>
        <div className="ib-activity-days" style={{ width: layout.width, height: layout.top, marginBottom: -layout.top }} aria-hidden="true">
          {days.map((day, i) => {
            const narrow = day.hours * layout.cell < (size === 'preview' ? 76 : 64);
            const withMonth = !narrow || i === 0 || day.date.getDate() === 1;
            return (
              <span key={day.col} className="ib-activity-day" style={{ left: day.col * layout.cell, width: day.hours * layout.cell }} data-narrow={narrow ? '' : undefined}>
                <span className="ib-activity-wd">{day.date.toLocaleDateString(undefined, { weekday: narrow ? 'narrow' : 'short' })}</span>
                <span className="ib-activity-dt">{day.date.toLocaleDateString(undefined, withMonth ? { month: 'short', day: 'numeric' } : { day: 'numeric' })}</span>
              </span>
            );
          })}
        </div>
        <svg
          ref={svg}
          className="ib-activity-svg"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden="true"
          data-marks={paths.marks}
          {...(interactive
            ? {
                onPointerMove: onMove,
                onPointerDown: onMove,
                onPointerLeave: (event: PointerEvent<SVGSVGElement>) => event.pointerType === 'mouse' && setHover(null),
                onClick,
                style: { cursor: hover ? 'pointer' : undefined },
              }
            : {})}
        >
          <path className="ib-activity-dline" d={paths.days} />
          {shown && <rect className="ib-activity-band" x={0} y={layout.top + shown.row * layout.pitch} width={layout.width} height={layout.pitch} rx={3} />}
          {look === 'blend' ? (
            <>
              <path className="ib-activity-strand" d={paths.strands} />
              {paths.tiers.map((d, i) => (
                <path key={i} className={`ib-activity-t${i}`} d={d} />
              ))}
            </>
          ) : (
            paths.steps.map((d, i) => <path key={i} className={`ib-activity-s${i}`} d={d} />)
          )}
          {ring && <circle className="ib-activity-ring" cx={ring.x} cy={ring.y} r={ring.r} data-activity-ring="" />}
        </svg>
      </div>
      {facts && (
        <div className="ib-activity-tip" ref={tip} role="tooltip" data-activity-tip="">
          <div className="ib-activity-tip-n" dir="auto">
            {facts.name}
          </div>
          <div className="ib-activity-tip-v">
            <b>{plural(facts.count, 'message')}</b> {facts.hour}
          </div>
          <div className="ib-activity-tip-v">
            <b>{plural(facts.dayCount, 'message')}</b> that day
          </div>
          <div className="ib-activity-tip-m">
            Started {facts.started}, last message {facts.last}, {plural(facts.total, 'message')} in all
          </div>
          {pointerKind.current !== 'mouse' && <div className="ib-activity-tip-m">Tap again to open</div>}
        </div>
      )}
    </div>
  );
}

function ActivityKey({ look }: { look: ActivityLook }) {
  return (
    <div className="ib-activity-key" aria-hidden="true">
      <span>1</span>
      <svg width={ACTIVITY_STEPS.length * 14} height={14} viewBox={`0 0 ${ACTIVITY_STEPS.length * 14} 14`}>
        {ACTIVITY_STEPS.map((count, i) =>
          look === 'blend' ? (
            <circle key={count} className={`ib-activity-t${activityTier(count)}`} cx={7 + i * 14} cy={7} r={activityRadius(count, { rMin: 1.5, rMax: 5.5 })} />
          ) : (
            <circle key={count} className={`ib-activity-s${i}`} cx={7 + i * 14} cy={7} r={3} />
          ),
        )}
      </svg>
      <span>10+ messages an hour</span>
    </div>
  );
}

export function ActivityChart({ projects, names, project: startProject, phone, refreshKey = null, onOpenThread, now = () => new Date(), look: lookProp }: ActivityChartProps) {
  const look = useMemo<ActivityLook>(() => lookProp ?? activityLookOf(typeof location === 'undefined' ? '' : location.search), [lookProp]);
  const ownProject = (id: string | null) => (id && (projects.length === 0 || projects.some((p) => p.id === id)) ? id : null);
  const [project, setProject] = useState<string | null>(() => ownProject(startProject));
  useEffect(() => {
    if (project && ownProject(project) === null) setProject(null);
  }, [projects, project]);
  const [range, setRange] = useState<ActivityRange>(() => defaultActivityRange(phone));
  const [read, setRead] = useState<{ model: InboxActivityModel; range: ActivityRange; project: string | null } | null>(null);
  const model = read?.model ?? null;
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const [open, setOpen] = useState(false);
  const section = useRef<HTMLElement>(null);
  const [previewBox, previewSize] = useBox<HTMLDivElement>();
  const { colorTheme, resolvedMode } = useTheme();
  const [ink, setInk] = useState<ActivityInk | null>(null);

  useEffect(() => {
    const el = section.current;
    if (!el || typeof requestAnimationFrame === 'undefined') return;
    const frame = requestAnimationFrame(() => setInk(fitActivityInk(el, look)));
    return () => cancelAnimationFrame(frame);
  }, [colorTheme, resolvedMode, look]);

  const firstKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === firstKey.current) return;
    const timer = setTimeout(() => setReads((n) => n + 1), REFRESH_AFTER_MS);
    return () => clearTimeout(timer);
  }, [refreshKey]);

  useEffect(() => {
    let live = true;
    const { from, to } = activitySpan(range, now());
    const asked = { range, project };
    inboxApi.activity(from, to, project).then(
      (next) => {
        if (!live) return;
        setRead({ model: next, ...asked });
        setError(null);
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, [range, project, reads]);

  const rows = useMemo(() => (model ? activityRows(model) : []), [model]);
  const days = useMemo(() => (model ? activityDays(new Date(model.from), new Date(model.to)) : []), [model]);
  const total = useMemo(() => rows.reduce((sum, row) => sum + row.counts.reduce((a, b) => a + b, 0), 0), [rows]);
  const shownProject = read?.project ?? null;
  const where = shownProject ? (names.get(shownProject) ?? 'this project') : 'every project';
  const summary = read && rows.length > 0 ? `${plural(rows.length, 'thread')}, ${plural(total, 'message')} ${rangeWords(read.range)}` : '';
  const inkStyle = ink ? (activityInkStyle(ink) as CSSProperties) : undefined;

  const longest = phone ? 7 : ACTIVITY_RANGES[ACTIVITY_RANGES.length - 1]!;
  const ways = [read && read.range < longest ? 'a longer range' : null, projects.length > 1 || shownProject ? 'another project' : null].filter(Boolean).join(' or ');
  const emptyNote = (inFull: boolean) =>
    read &&
    rows.length === 0 && (
      <p className="ib-activity-note" data-activity-empty="">
        No messages {shownProject ? `in ${where} ` : ''}
        {rangeWords(read.range)}.{ways && (inFull ? ` Try ${ways}.` : ` Expand to try ${ways}.`)}{ways ? ' Or come back later once you’ve gotten some work done.' : ' Come back later once you’ve gotten some work done.'}
      </p>
    );
  const empty = emptyNote(false);
  const failed = error && (
    <p className="ib-activity-note" role="alert">
      Activity could not be read. {error}{' '}
      <button type="button" className="ib-lnk" onClick={() => setReads((n) => n + 1)}>
        Try again
      </button>
    </p>
  );

  return (
    <section ref={section} className="ib-sgroup ib-activity" data-activity="" data-activity-look={look} aria-label="Activity" style={inkStyle} data-activity-ink={ink?.ink}>
      <div className="ib-activity-bar">
        <span className="ib-activity-sum" data-activity-summary="">
          {summary && (shownProject ? `${where}: ${summary}` : summary)}
        </span>
        <button type="button" className="ib-btn ib-activity-expand" data-activity-expand="" onClick={() => setOpen(true)} disabled={!model && !error}>
          <Icon name="expand" size={14} />
          Expand
        </button>
      </div>
      <div className="ib-activity-box" ref={previewBox}>
        {failed ||
          empty ||
          (model && previewSize.width > 0 ? (
            <div className="ib-activity-preview" data-activity-preview="" onClick={() => setOpen(true)} title="Open full screen">
              <ActivityPlot size="preview" rows={rows} days={days} model={model} look={look} width={previewSize.width} />
            </div>
          ) : (
            <div className="ib-activity-wait" aria-busy="true" />
          ))}
      </div>
      {model && rows.length > 0 && <ActivityKey look={look} />}
      {open && (model || error) && (
        <ActivityFull
          onClose={() => setOpen(false)}
          inkStyle={inkStyle}
          look={look}
          phone={phone}
          range={range}
          onRange={setRange}
          project={project}
          onProject={setProject}
          projects={projects}
          names={names}
          model={model}
          rows={rows}
          days={days}
          summary={summary}
          note={failed || emptyNote(true) || null}
          onOpen={(row) => {
            setOpen(false);
            onOpenThread(row.id, project);
          }}
        />
      )}
    </section>
  );
}

interface FullProps {
  onClose: () => void;
  inkStyle: CSSProperties | undefined;
  look: ActivityLook;
  phone: boolean;
  range: ActivityRange;
  onRange: (range: ActivityRange) => void;
  project: string | null;
  onProject: (project: string | null) => void;
  projects: readonly ProjectFolder[];
  names: ReadonlyMap<string, string>;
  model: InboxActivityModel | null;
  rows: readonly ActivityRow[];
  days: readonly ActivityDay[];
  summary: string;
  note: React.ReactNode;
  onOpen: (row: ActivityRow) => void;
}

function ActivityFull({ onClose, inkStyle, look, phone, range, onRange, project, onProject, projects, names, model, rows, days, summary, note, onOpen }: FullProps) {
  const [body, size] = useBox<HTMLDivElement>();
  return (
    <Modal labelledBy="ib-activity-title" onClose={onClose} testId="activity" ownKeys initialFocus="[data-activity-close]" className="ib-activity-lb">
      <div className="ib-activity ib-activity-full" style={inkStyle} data-activity-look={look}>
        <div className="ib-activity-lbhead">
          <h2 id="ib-activity-title">Activity</h2>
          <span className="ib-seg" role="radiogroup" aria-label="Range">
            {ACTIVITY_RANGES.filter((days) => !phone || days <= 7).map((days) => (
              <label key={days} className="ib-seg-o" data-on={range === days ? '' : undefined}>
                <input type="radio" name="ib-activity-range" value={days} checked={range === days} onChange={() => onRange(days)} />
                {ACTIVITY_RANGE_LABEL[days]}
              </label>
            ))}
          </span>
          {projects.length > 1 && <ProjectFilter projects={projects} names={names} value={project} phone={phone} onChange={onProject} />}
          <span className="ib-activity-sum">{summary}</span>
          <button type="button" className="ib-btn ib-ghost ib-icon ib-activity-close" aria-label="Close" data-activity-close="" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="ib-activity-lbbody" ref={body}>
          {note ??
            (model && size.width > 0 && <ActivityPlot size="full" rows={rows} days={days} model={model} look={look} width={size.width} height={size.height} onOpen={onOpen} />)}
        </div>
        {rows.length > 0 && <ActivityKey look={look} />}
      </div>
    </Modal>
  );
}
