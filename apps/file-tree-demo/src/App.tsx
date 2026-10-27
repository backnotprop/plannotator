/**
 * The file tree demo: the `@plannotator/ui` FileTree as it is, over real and
 * worst-case path lists, with a small panel of controls and a timing readout.
 * Dev only (see ../vite.config.ts).
 *
 * The URL keeps the controls (`?set=huge&theme=dark&w=320&phone=1`), so a
 * view can be shared or opened again. `window.__demo` is for headless runs.
 */
import React, { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileTree, FILE_TREE_ROOT, useFileTree, type FileTreeBadge, type FileTreeHandle, type FileTreeStore } from '@plannotator/ui/components/file-tree';
import { buildBadges, DATASETS, hugeMonorepo, loadRepo, worstCases, type Dataset, type DatasetId } from './datasets';

// ------------------------------------------------------------------ settings

const THEMES = Object.keys(import.meta.glob('../../../packages/ui/themes/*.css'))
  .map((p) => p.slice(p.lastIndexOf('/') + 1, -4))
  .sort();

const DENSITIES = { compact: 20, default: 22, comfortable: 28, touch: 44 } as const;
type Density = keyof typeof DENSITIES;
type Guides = 'hover' | 'always' | 'never';

interface Settings {
  set: DatasetId;
  mode: 'light' | 'dark';
  theme: string;
  guides: Guides;
  density: Density;
  indent: number;
  git: boolean;
  comments: boolean;
  filter: string;
  width: number;
  phone: boolean;
}

const DEFAULTS: Settings = { set: 'repo', mode: 'light', theme: 'plannotator', guides: 'hover', density: 'default', indent: 8, git: true, comments: true, filter: '', width: 360, phone: false };

function readSettings(): Settings {
  const q = new URLSearchParams(location.search);
  const s = { ...DEFAULTS };
  const set = q.get('set');
  if (set === 'repo' || set === 'huge' || set === 'worst') s.set = set;
  if (q.get('theme') === 'dark' || q.get('mode') === 'dark') s.mode = 'dark';
  const name = q.get('name');
  if (name && THEMES.includes(name)) s.theme = name;
  const guides = q.get('guides');
  if (guides === 'always' || guides === 'never') s.guides = guides;
  const density = q.get('density');
  if (density && density in DENSITIES) s.density = density as Density;
  const indent = Number(q.get('indent'));
  if (indent >= 4 && indent <= 24) s.indent = indent;
  if (q.get('git') === '0') s.git = false;
  if (q.get('comments') === '0') s.comments = false;
  s.filter = q.get('filter') ?? '';
  const w = Number(q.get('w'));
  if (w >= 320 && w <= 960) s.width = w;
  if (q.get('phone') === '1') {
    s.phone = true;
    if (!q.get('density')) s.density = 'touch';
  }
  return s;
}

function writeSettings(s: Settings): void {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(s) as [keyof Settings, Settings[keyof Settings]][]) {
    if (v === DEFAULTS[k]) continue;
    if (k === 'mode') q.set('theme', String(v));
    else if (k === 'theme') q.set('name', String(v));
    else if (k === 'width') q.set('w', String(v));
    else q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  const search = q.toString();
  history.replaceState(null, '', search ? `?${search}` : location.pathname);
}

// ------------------------------------------------------------------ timing

/** Resolves after the next paint: a frame, then a task after it. */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

interface Timing {
  label: string;
  ms: number;
}

interface ScrollStats {
  frames: number;
  avg: number;
  worst: number;
  p95: number;
}

function fmt(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '–';
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

// ------------------------------------------------------------------ live change

interface LiveLog {
  n: number;
  text: string;
}

/**
 * One add, one rename and one remove in a folder on screen: the open file's
 * folder, else the first open folder in view, else the top level. What a
 * folder watch would send: `add` / `remove` on the store.
 */
function liveChange(store: FileTreeStore, n: number, selected: string | null, topRow: number): { added: string; renamed?: [string, string]; removed?: string } {
  const model = store.model;
  let dir = FILE_TREE_ROOT;
  if (selected) {
    const id = model.find(selected);
    if (id > FILE_TREE_ROOT) dir = model.parentOf(id);
  }
  if (dir === FILE_TREE_ROOT) {
    const rows = model.rows(Math.max(0, topRow), 60);
    const open = rows.find((r) => r.isDir && r.expanded && model.childrenOf(r.id).length > 0);
    if (open) dir = open.id;
  }
  const prefix = dir === FILE_TREE_ROOT ? '' : `${model.pathOf(dir)}/`;
  const files = model.childrenOf(dir).filter((id) => !model.isDir(id) && model.isShown(id)).map((id) => model.pathOf(id));
  const isLive = (p: string) => /\.live-\d+\.ts$/.test(p);
  // Named after the open file (else the folder's first file), so it lands next to it, in view.
  const anchor = (selected && files.includes(selected) ? selected : files.find((p) => !isLive(p))) ?? `${prefix}file`;
  const anchorName = anchor.slice(anchor.lastIndexOf('/') + 1);
  const stem = anchorName.includes('.') ? anchorName.slice(0, anchorName.indexOf('.')) || anchorName : anchorName;
  const added = `${prefix}${stem}.live-${n}.ts`;
  store.add(added);
  // Rename a file that is not the open one, and not one this click added.
  const renameFrom = files.find((p) => p !== selected && !isLive(p) && !/-renamed-\d+/.test(p));
  let renamed: [string, string] | undefined;
  if (renameFrom) {
    const dot = renameFrom.lastIndexOf('.');
    const slash = renameFrom.lastIndexOf('/');
    const to = dot > slash + 1 ? `${renameFrom.slice(0, dot)}-renamed-${n}${renameFrom.slice(dot)}` : `${renameFrom}-renamed-${n}`;
    store.remove(renameFrom);
    store.add(to);
    renamed = [renameFrom, to];
  }
  // Remove an earlier live file in this folder, else a file that is not open.
  const earlier = files.find((p) => isLive(p) && p !== added);
  const removeOne = earlier ?? files.find((p) => p !== selected && p !== renameFrom);
  let removed: string | undefined;
  if (removeOne) {
    store.remove(removeOne);
    removed = removeOne;
  }
  return { added, renamed, removed };
}

// ------------------------------------------------------------------ app

export function App() {
  const [s, setS] = useState<Settings>(readSettings);
  const set = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => setS((prev) => ({ ...prev, [key]: value })), []);
  useEffect(() => writeSettings(s), [s]);

  // Theme on <html>, as the apps set it.
  useEffect(() => {
    const el = document.documentElement;
    for (const c of [...el.classList]) if (c.startsWith('theme-') || c === 'light' || c === 'dark') el.classList.remove(c);
    el.classList.add(`theme-${s.theme}`, s.mode);
    el.style.colorScheme = s.mode;
  }, [s.theme, s.mode]);

  // The data set, loaded once per set.
  const [data, setData] = useState<{ id: DatasetId; dataset: Dataset; loadMs: number; t0: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    const t0 = performance.now();
    const load = s.set === 'repo' ? loadRepo() : Promise.resolve(s.set === 'huge' ? hugeMonorepo() : worstCases());
    load.then(
      (dataset) => live && setData({ id: s.set, dataset, loadMs: performance.now() - t0, t0: performance.now() }),
      (e) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [s.set]);

  const narrow = useNarrow();

  const panel = <Controls s={s} set={set} />;
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row" data-demo-root="">
      {narrow ? (
        <details className="border-b border-border bg-card text-sm" data-demo-controls="">
          <summary className="cursor-pointer select-none px-3 py-2 font-medium">File tree demo · controls</summary>
          <div className="max-h-[60vh] overflow-auto">{panel}</div>
        </details>
      ) : (
        <aside className="w-[260px] flex-shrink-0 overflow-auto border-e border-border bg-card text-sm" data-demo-controls="">
          {panel}
        </aside>
      )}
      <main className="flex min-h-0 min-w-0 flex-1 items-stretch justify-center overflow-auto">
        {error ? (
          <p className="p-6 text-destructive">Could not load the set: {error}</p>
        ) : !data || data.id !== s.set ? (
          <p className="p-6 text-muted-foreground">Loading…</p>
        ) : (
          <Stage key={data.id} s={s} set={set} data={data} narrow={narrow} />
        )}
      </main>
    </div>
  );
}

function useNarrow(): boolean {
  const query = '(max-width: 767px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

// ------------------------------------------------------------------ controls

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange, name }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; name: string }) {
  return (
    <div role="radiogroup" aria-label={name} className={`grid rounded-md border border-border p-0.5 ${options.length > 3 ? 'grid-cols-2' : 'auto-cols-fr grid-flow-col'}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded px-2 py-1 text-xs ${value === o.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const input = 'rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring';

function Controls({ s, set }: { s: Settings; set: <K extends keyof Settings>(key: K, value: Settings[K]) => void }) {
  return (
    <div className="flex flex-col gap-4 p-3">
      <div>
        <h1 className="text-sm font-semibold">File tree demo</h1>
        <p className="text-xs text-muted-foreground">@plannotator/ui FileTree, as it is.</p>
      </div>
      <Field label="Data set">
        <select className={input} value={s.set} onChange={(e) => set('set', e.target.value as DatasetId)} data-control="set">
          {DATASETS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Mode">
        <Segmented name="Mode" value={s.mode} onChange={(v) => set('mode', v)} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      </Field>
      <Field label="Theme">
        <select className={input} value={s.theme} onChange={(e) => set('theme', e.target.value)} data-control="theme">
          {THEMES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Indent guides">
        <Segmented name="Indent guides" value={s.guides} onChange={(v) => set('guides', v)} options={[{ value: 'hover', label: 'Hover' }, { value: 'always', label: 'Always' }, { value: 'never', label: 'Never' }]} />
      </Field>
      <Field label="Density">
        <Segmented
          name="Density"
          value={s.density}
          onChange={(v) => set('density', v)}
          options={(Object.keys(DENSITIES) as Density[]).map((d) => ({ value: d, label: `${d[0].toUpperCase()}${d.slice(1)}` }))}
        />
      </Field>
      <Field label={`Indent · ${s.indent} px`}>
        <input type="range" min={4} max={20} step={2} value={s.indent} onChange={(e) => set('indent', Number(e.target.value))} />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Marks</span>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.git} onChange={(e) => set('git', e.target.checked)} data-control="git" /> Git status (M A D U)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.comments} onChange={(e) => set('comments', e.target.checked)} data-control="comments" /> Comment counts
        </label>
      </div>
      <Field label={`Tree width · ${s.phone ? 390 : s.width} px`}>
        <input type="range" min={320} max={960} step={10} value={s.width} disabled={s.phone} onChange={(e) => set('width', Number(e.target.value))} data-control="width" />
      </Field>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={s.phone}
          onChange={(e) => {
            set('phone', e.target.checked);
            set('density', e.target.checked ? 'touch' : 'default');
          }}
          data-control="phone"
        />
        Phone preset (390 × 844, touch rows)
      </label>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Keys: click the tree or Tab to it, then ↑ ↓ ← → Home End PgUp PgDn, type a name to jump, Enter or Space to open.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ stage

function Stage({ s, set, data, narrow }: { s: Settings; set: <K extends keyof Settings>(key: K, value: Settings[K]) => void; data: { id: DatasetId; dataset: Dataset; loadMs: number; t0: number }; narrow: boolean }) {
  const { dataset } = data;
  const [liveBadges, setLiveBadges] = useState<Map<string, FileTreeBadge>>(() => new Map());
  const baseBadges = useMemo(() => buildBadges(dataset.paths, dataset.status, { git: s.git, comments: s.comments }), [dataset, s.git, s.comments]);
  const badges = useMemo(() => {
    if (liveBadges.size === 0 || !s.git) return baseBadges;
    const out = new Map(baseBadges ?? []);
    for (const [k, v] of liveBadges) out.set(k, { ...out.get(k), ...v });
    return out;
  }, [baseBadges, liveBadges, s.git]);

  const store = useFileTree(dataset.paths, { badges, filter: s.filter, initialExpanded: dataset.expanded });
  const treeRef = useRef<FileTreeHandle>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // ---- timing
  const [firstPaint, setFirstPaint] = useState<number | null>(null);
  const [indexMs, setIndexMs] = useState<number | null>(null);
  const [lastAction, setLastAction] = useState<Timing | null>(null);
  const [lastCommit, setLastCommit] = useState<Timing | null>(null);
  const [scroll, setScroll] = useState<ScrollStats | null>(null);
  const [counts, setCounts] = useState({ rows: 0, mounted: 0, onScreen: 0, listed: 0 });
  const [log, setLog] = useState<LiveLog[]>([]);
  const [auto, setAuto] = useState(false);
  const liveN = useRef(0);
  const pendingAction = useRef<string | null>(null);

  useEffect(() => {
    void afterPaint().then(() => setFirstPaint(performance.now() - data.t0));
    void store.whenReady().then(() => setIndexMs(performance.now() - data.t0));
  }, [store, data.t0]);

  const timed = useCallback((label: string, fn: () => void) => {
    const t0 = performance.now();
    pendingAction.current = label;
    fn();
    void afterPaint().then(() => setLastAction({ label, ms: performance.now() - t0 }));
  }, []);

  // Filter typing: time from the keystroke to the paint.
  const filterT0 = useRef(0);
  useEffect(() => {
    if (!filterT0.current) return;
    const t0 = filterT0.current;
    filterT0.current = 0;
    void afterPaint().then(() => setLastAction({ label: 'filter', ms: performance.now() - t0 }));
  }, [s.filter]);

  // Row counts after every change (cheap DOM reads, after paint).
  const treeBox = useRef<HTMLDivElement>(null);
  const measureCounts = useCallback(() => {
    const el = treeBox.current?.querySelector<HTMLElement>('[role="tree"]');
    if (!el) return;
    const items = el.querySelectorAll<HTMLElement>('[role="treeitem"]');
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;
    let onScreen = 0;
    for (const it of items) {
      const y = it.offsetTop;
      if (y + it.offsetHeight > top && y < bottom) onScreen++;
    }
    setCounts({ rows: store.model.rowCount, mounted: items.length, onScreen, listed: store.model.listedCount });
  }, [store]);
  useEffect(() => store.subscribe(() => void afterPaint().then(measureCounts)), [store, measureCounts]);
  useEffect(() => {
    void afterPaint().then(measureCounts);
  }, [measureCounts, s.density, s.width, s.phone, s.indent]);

  // Scroll: frame times while scroll events arrive; a burst ends 250 ms after the last one.
  useEffect(() => {
    const el = treeBox.current?.querySelector<HTMLElement>('[role="tree"]');
    if (!el) return;
    let frames: number[] = [];
    let last = 0;
    let raf = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const tick = (t: number) => {
      if (last) frames.push(t - last);
      last = t;
      raf = requestAnimationFrame(tick);
    };
    const end = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      if (frames.length > 1) {
        const sorted = [...frames].sort((a, b) => a - b);
        setScroll({
          frames: frames.length,
          avg: frames.reduce((a, b) => a + b, 0) / frames.length,
          worst: sorted[sorted.length - 1],
          p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
        });
      }
      frames = [];
      measureCounts();
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(tick);
      clearTimeout(idle);
      idle = setTimeout(end, 250);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
      clearTimeout(idle);
    };
  }, [store, measureCounts]);

  // React's own time for the tree's commits. Kept in a ref and shown at most
  // four times a second, so the readout never re-renders the tree or slows a scroll.
  const commitRef = useRef<Timing | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onRender = useCallback<React.ProfilerOnRenderCallback>((_id, phase, actual) => {
    const label = pendingAction.current ?? (phase === 'mount' ? 'mount' : 'update');
    pendingAction.current = null;
    commitRef.current = { label, ms: actual };
    if (commitTimer.current === undefined) {
      commitTimer.current = setTimeout(() => {
        commitTimer.current = undefined;
        setLastCommit(commitRef.current);
      }, 250);
    }
  }, []);
  useEffect(() => () => clearTimeout(commitTimer.current), []);

  const doLive = useCallback(() => {
    const n = ++liveN.current;
    const el = treeBox.current?.querySelector<HTMLElement>('[role="tree"]');
    const rowH = el ? (el.querySelector<HTMLElement>('[role="treeitem"]')?.offsetHeight ?? 22) : 22;
    const topRow = el ? Math.floor(el.scrollTop / rowH) : 0;
    let result: ReturnType<typeof liveChange> | null = null;
    timed('live change', () => {
      result = liveChange(store, n, selected, topRow);
    });
    if (!result) return;
    const r = result as ReturnType<typeof liveChange>;
    const entries: LiveLog[] = [{ n, text: `+ ${r.added}` }];
    if (r.renamed) entries.push({ n, text: `→ ${r.renamed[0].split('/').pop()} → ${r.renamed[1].split('/').pop()}` });
    if (r.removed) entries.push({ n, text: `− ${r.removed}` });
    setLog((prev) => [...entries, ...prev].slice(0, 8));
    setLiveBadges((prev) => {
      const next = new Map(prev);
      next.set(r.added, { letter: 'A', tone: 'added', label: 'Added' });
      if (r.renamed) {
        next.delete(r.renamed[0]);
        next.set(r.renamed[1], { letter: 'R', tone: 'renamed', label: 'Renamed' });
      }
      if (r.removed) next.delete(r.removed);
      return next;
    });
    if (r.removed && r.removed === selected) setSelected(null);
  }, [store, selected, timed]);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(doLive, 1500);
    return () => clearInterval(id);
  }, [auto, doLive]);

  // For headless runs.
  useEffect(() => {
    (window as unknown as { __demo: unknown }).__demo = { store, tree: treeRef, live: doLive, counts: () => counts, select: setSelected };
  }, [store, doLive, counts]);

  // The phone preset is a 390 × 844 screen (inside an 8 px frame); its panes stack full width.
  const width = s.phone || narrow ? undefined : s.width;
  const stacked = s.phone || narrow;
  const badge = selected ? store.badgeOf(selected) : undefined;
  const btn = 'rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50';

  return (
    <div
      className={`flex min-h-0 ${stacked ? 'flex-col' : 'flex-row'} ${s.phone ? 'my-4 h-[860px] w-[406px] flex-shrink-0 overflow-hidden rounded-[28px] border-8 border-foreground/80 shadow-xl' : 'h-full w-full'}`}
      data-demo-stage=""
    >
      <section className={`flex min-h-0 flex-col border-border bg-card ${stacked ? 'flex-[3] border-b' : 'flex-shrink-0 border-e'}`} style={{ width }} data-demo-tree-pane="">
        <div className="flex flex-col gap-2 border-b border-border p-2">
          <input
            type="search"
            placeholder="Filter files…"
            aria-label="Filter files"
            className={`${input} w-full`}
            value={s.filter}
            onChange={(e) => {
              filterT0.current = performance.now();
              set('filter', e.target.value);
            }}
            data-control="filter"
          />
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={btn} onClick={() => timed('expand all', () => store.expandAll())} data-control="expand-all">
              Expand all
            </button>
            <button type="button" className={btn} onClick={() => timed('collapse all', () => store.collapseAll())} data-control="collapse-all">
              Collapse all
            </button>
            <button type="button" className={btn} onClick={doLive} data-control="live">
              Simulate live change
            </button>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} data-control="auto-live" /> every 1.5 s
            </label>
          </div>
        </div>
        <div ref={treeBox} className="min-h-0 flex-1" data-guides-mode={s.guides}>
          <TreePane treeRef={treeRef} store={store} selected={selected} onOpen={setSelected} rowHeight={DENSITIES[s.density]} indent={s.indent} onRender={onRender} />
        </div>
      </section>
      <section className={`flex min-h-0 min-w-0 flex-col ${stacked ? 'flex-[2]' : 'flex-1'}`} data-demo-preview="">
        <Readout
          note={dataset.note}
          loadMs={data.loadMs}
          firstPaint={firstPaint}
          indexMs={indexMs}
          loading={store.loading}
          counts={counts}
          lastAction={lastAction}
          lastCommit={lastCommit}
          scroll={scroll}
          compact={stacked}
        />
        <Preview path={selected} badge={badge} />
        {log.length > 0 && !stacked && (
          <div className="border-t border-border p-3 font-mono text-[11px] text-muted-foreground" data-demo-live-log="">
            {log.map((l, i) => (
              <div key={`${l.n}-${i}`} className="truncate">
                #{l.n} {l.text}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** The tree alone, memoized: the readout's own updates never re-render it. */
const TreePane = React.memo(function TreePane(p: {
  treeRef: React.RefObject<FileTreeHandle | null>;
  store: FileTreeStore;
  selected: string | null;
  onOpen: (path: string) => void;
  rowHeight: number;
  indent: number;
  onRender: React.ProfilerOnRenderCallback;
}) {
  return (
    <Profiler id="tree" onRender={p.onRender}>
      <FileTree ref={p.treeRef} tree={p.store} selectedPath={p.selected} onOpen={p.onOpen} rowHeight={p.rowHeight} indent={p.indent} label="Files" />
    </Profiler>
  );
});

// ------------------------------------------------------------------ readout

function Readout(p: {
  note: string;
  loadMs: number;
  firstPaint: number | null;
  indexMs: number | null;
  loading: boolean;
  counts: { rows: number; mounted: number; onScreen: number; listed: number };
  lastAction: Timing | null;
  lastCommit: Timing | null;
  scroll: ScrollStats | null;
  compact: boolean;
}) {
  const cells: [string, string][] = [
    ['Files', p.counts.listed.toLocaleString()],
    ['Rows', p.counts.rows.toLocaleString()],
    ['On screen', String(p.counts.onScreen)],
    ['In DOM', String(p.counts.mounted)],
    ['First paint', fmt(p.firstPaint)],
    ['Full index', p.loading ? 'building…' : fmt(p.indexMs)],
    [p.lastAction ? `Last: ${p.lastAction.label}` : 'Last action', fmt(p.lastAction?.ms)],
    [p.lastCommit ? `React commit (${p.lastCommit.label})` : 'React commit', fmt(p.lastCommit?.ms)],
    ['Scroll frames avg/p95/max', p.scroll ? `${p.scroll.avg.toFixed(1)} / ${p.scroll.p95.toFixed(1)} / ${p.scroll.worst.toFixed(1)} ms` : 'scroll the tree'],
  ];
  return (
    <div className="border-b border-border bg-card/60 p-3" data-demo-readout="">
      <div className="mb-2 truncate text-xs text-muted-foreground">{p.note}</div>
      <dl className={`grid gap-x-4 gap-y-1.5 text-xs ${p.compact ? 'grid-cols-2' : 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))]'}`}>
        {cells.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{k}</dt>
            <dd className="font-mono tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------ preview

function Preview({ path, badge }: { path: string | null; badge: FileTreeBadge | undefined }) {
  if (!path) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground" data-demo-preview-empty="">
        Open a file (click, or Enter / Space) to show it here.
      </div>
    );
  }
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-demo-preview-file={path}>
      <div className="border-b border-border px-3 py-2">
        <div className="truncate text-sm font-medium" dir="auto" title={name}>
          {name}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-1 text-xs text-muted-foreground" dir="auto">
          {parts.slice(0, -1).map((seg, i) => (
            <span key={i} className="break-all">
              {seg} /
            </span>
          ))}
        </div>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed text-muted-foreground">
        {`// ${path}
// depth ${parts.length - 1}${ext ? ` · .${ext}` : ''}${badge?.label ? ` · ${badge.label}` : ''}
//
// A dummy preview: this demo is about the tree.

export const path = ${JSON.stringify(path)};
`}
      </pre>
    </div>
  );
}
