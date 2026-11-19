/**
 * The demo page. Development only: no product surface links here.
 *
 *   /                      plan and canvas side by side (a phone gets the plan)
 *   /?bench=plan&n=50      a plan with n snapshots of one 2,000-object canvas
 *   /?bench=canvas&n=2000  the editor alone on an n-object canvas (&rich: pictures, HTML items, cards, long notes;
 *                          &ink=600 drawn lines, &curves=400 curved connectors, &html=12 moving HTML items)
 *   /?view=split           plan and canvas side by side
 *   /?view=canvas          the canvas alone
 *   &theme=dark            start dark
 */
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import type { Block } from '@plannotator/ui/types';
import { blockEndLine, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import type { CanvasStore } from '../events/store';
import { createId } from '../model/ids';
import type { ReferenceObject, Snapshot } from '../model/types';
import { createMemoryAssets } from '../react/memory-assets';
import { type People, PeopleProvider } from '../react/people';
import type { PasteResolver } from '../react/references';
import { pictureResolver } from '../model/assets';
import { routeLinkPreview } from '../react/link-preview';
import { CanvasEditor } from '../react/CanvasEditor';
import { HtmlItemFacesProvider } from '../react/objects';
import type { HtmlItemFace } from '../model/html-item';
import { findSnapshotBlocks, insertSnapshotBlock } from '../snapshot/block';
import { CanvasStage } from '../snapshot/CanvasStage';
import { createSnapshotDirectiveRenderer } from '../snapshot/directive';
import { snapshotToSvg } from '../snapshot/picture';
import { behindSnapshots } from '../snapshot/resolve';
import { SNAPSHOT_STRINGS } from '../snapshot/strings';
import type { PlanDropTarget } from '../react/plan-drop';
import { CanvasRegistry, CanvasRegistryProvider } from '../snapshot/registry';
import type { SnapshotOpenRequest } from '../snapshot/SnapshotFigure';
import { indexFor } from '../view/document-index';
import { MARKS_PLAN, createMarksStore } from './marks';
import { PlanPane } from './PlanPane';
import { DATA_SETS, type DataSet, EMPTY_PLAN, FAR_PLAN, ONE_PLAN, STACKED_PLAN, bigPlan, createBigStore, createEmptyStore, createFarStore, createOneStore, createStackedStore, createWorstStore, worstPlan } from './worst';
import { CHART_IMAGE, SAMPLE_CANVAS_ID, SAMPLE_PLAN, addBenchMarks, createLargeStore, createLongPlan, createSampleStore, createTypedStore } from './sample';

const params = new URLSearchParams(location.search);
const bench = params.get('bench');
const count = Number(params.get('n')) || (bench === 'plan' ? 50 : 2000);

/** Dev only: which dataset the demo draws (`?data=worst`, see `worst.ts`). */
const data = (DATA_SETS.some((set) => set.id === params.get('data')) ? params.get('data') : 'demo') as DataSet;

function storeFor(set: DataSet): CanvasStore {
  if (set === 'marks') return createMarksStore();
  if (set === 'worst') return createWorstStore();
  if (set === 'empty') return createEmptyStore();
  if (set === 'one') return createOneStore();
  if (set === 'huge') return createBigStore(2000);
  if (set === 'max') return createBigStore(10_000);
  if (set === 'stacked') return createStackedStore();
  if (set === 'far') return createFarStore();
  return createSampleStore();
}
function planFor(set: DataSet): string {
  if (set === 'marks') return MARKS_PLAN;
  if (set === 'worst') return worstPlan();
  if (set === 'empty') return EMPTY_PLAN;
  if (set === 'one') return ONE_PLAN;
  if (set === 'huge') return bigPlan(2000);
  if (set === 'max') return bigPlan(10_000);
  if (set === 'stacked') return STACKED_PLAN;
  if (set === 'far') return FAR_PLAN;
  return SAMPLE_PLAN;
}

/** The dev-only dataset switch: bottom centre, plain chrome, kept in the URL. */
function DataToggle() {
  const pick = (set: DataSet) => {
    const next = new URLSearchParams(location.search);
    if (set === 'demo') next.delete('data');
    else next.set('data', set);
    location.search = next.toString();
  };
  return (
    <div role="radiogroup" aria-label="Data" style={{ position: 'fixed', left: '50%', bottom: 6, transform: 'translateX(-50%)', zIndex: 900, display: 'flex', gap: 2, padding: 2, background: '#e5e7eb', borderRadius: 8, font: '12px system-ui, sans-serif', maxWidth: 'calc(100vw - 12px)', overflowX: 'auto' }}>
      {DATA_SETS.map((set) => (
        <button key={set.id} type="button" role="radio" aria-checked={data === set.id} onClick={() => pick(set.id)} style={{ border: 0, borderRadius: 6, padding: '4px 8px', whiteSpace: 'nowrap', cursor: 'pointer', color: '#111', background: data === set.id ? '#fff' : 'transparent', boxShadow: data === set.id ? '0 1px 2px rgb(0 0 0 / 0.15)' : 'none' }}>
          {set.label}
        </button>
      ))}
    </div>
  );
}

const snapshotCount = (count: number) => (count === 1 ? '1 snapshot' : `${count} snapshots`);

const registry = new CanvasRegistry();

/** The demo's host lends its two house faces to HTML items. A product host would lend its own. */
const HOUSE_FACES: HtmlItemFace[] = __HOUSE_FACES__;

/** The demo's people: one person and one agent. A product host answers from its own accounts. */
const people: People = (actor) => (actor.kind === 'agent' ? { name: 'Planner' } : actor.id === 'ana' ? { name: 'Ana', color: '#B9A6FF' } : actor.id === 'ines' ? { name: 'Ines', color: '#6d4aff' } : null);

// Where the demo keeps pictures: in memory, by content hash. A product host stores them itself.
const assets = createMemoryAssets();
const resolvePicture = pictureResolver(assets);

// The demo's own dev server mounts the link preview route (demo/vite.config.ts).
const linkPreview = routeLinkPreview('/__canvas/unfurl');

/** The demo's stand-in for a host that knows its own things: `artifact:<name>` and `plan:<heading>`. */
const resolvePaste: PasteResolver = (text) => {
  const artifact = text.match(/^artifact:(.+\.(png|jpe?g|gif|webp|html|md|txt|mp4|webm))$/i);
  if (artifact) {
    const ext = artifact[2].toLowerCase();
    const artifactKind = ext === 'html' ? 'html' : ext === 'md' ? 'markdown' : ext === 'txt' ? 'text' : ext === 'mp4' || ext === 'webm' ? 'video' : 'image';
    return { target: { kind: 'artifact', artifact: artifact[1], artifactKind }, title: artifact[1].split('/').pop() };
  }
  const plan = text.match(/^plan:(.+)$/i);
  return plan ? { target: { kind: 'plan', anchor: plan[1].trim() }, title: plan[1].trim() } : null;
};
let openSnapshot: (request: SnapshotOpenRequest) => void = () => {};

// The one place the canvas meets the plan renderer: a host's startup call.
configurePlannotatorUI({
  directiveRenderer: createSnapshotDirectiveRenderer({ registry, onOpen: (request) => openSnapshot(request), resolveImageSrc: resolvePicture }),
});

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(params.get('theme') === 'dark');
  useEffect(() => {
    document.documentElement.classList.toggle('light', !dark);
  }, [dark]);
  return [dark, () => setDark((value) => !value)];
}

function BenchCanvas() {
  const store = useMemo(() => (params.has('typed') ? createTypedStore(count, Number(params.get('connectors')) || 1500, Number(params.get('sketch')) || 0) : createLargeStore(count, 0, params.has('rich'))), []);
  useMemo(() => addBenchMarks(store, { ink: Number(params.get('ink')) || 0, curves: Number(params.get('curves')) || 0, html: Number(params.get('html')) || 0 }), [store]);
  useEffect(() => {
    (window as unknown as { __canvas: unknown }).__canvas = { store };
  }, [store]);
  return (
    <div style={{ height: '100%' }}>
      <CanvasEditor store={store} assets={assets} />
    </div>
  );
}

export function App() {
  return bench === 'canvas' ? <BenchCanvas /> : (
    <>
      <PlanAndCanvas />
      {import.meta.env.DEV && params.get('toggle') !== '0' ? <DataToggle /> : null}
    </>
  );
}

function PlanAndCanvas() {
  const [dark, toggleTheme] = useTheme();
  const store = useMemo<CanvasStore>(() => (bench === 'plan' ? createLargeStore(2000, count) : storeFor(data)), []);
  const canvasId = store.getDocument().id;
  const [available, setAvailable] = useState(true);
  const [markdown, setMarkdown] = useState(() => (bench === 'plan' ? createLongPlan(count) : planFor(data)));
  const [request, setRequest] = useState<SnapshotOpenRequest | null>(null);
  const [arrived, setArrived] = useState<string | null>(null);
  // The plan alone is the product's case: the canvas is reached through a figure. Side by side is for
  // dragging a snapshot from the board into the plan.
  const [layout, setLayout] = useState<'split' | 'plan' | 'canvas'>(params.get('view') === 'split' ? 'split' : params.get('view') === 'canvas' ? 'canvas' : 'plan');
  const plan = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const doc = useSyncExternalStore(store.subscribe, store.getDocument, store.getDocument);
  // "Update all in this plan": the plan's snapshots that are behind.
  const behind = useMemo(
    () => (bench ? [] : behindSnapshots(doc, indexFor(store), findSnapshotBlocks(markdown).map((found) => found.ref.snapshot))),
    [doc, markdown, store],
  );
  /** One gesture, so one undo takes every update back. */
  const updateAll = () => {
    const gesture = createId('g');
    for (const id of behind) store.dispatch({ type: 'update-snapshot', id }, { gesture });
  };
  const blocks = useMemo(() => parseMarkdownToBlocks(markdown), [markdown]);
  const blocksRef = useRef<Block[]>(blocks);
  blocksRef.current = blocks;

  useEffect(() => {
    registry.set(canvasId, available ? store : undefined);
  }, [available, canvasId, store]);

  useEffect(() => {
    // Mount the canvas in the same task as the click, so its first frame is the next one.
    openSnapshot = (next) => flushSync(() => setRequest(next));
    (window as unknown as { __canvas: unknown }).__canvas = { store, registry };
  }, [store]);

  /** Where a snapshot goes when it was not dropped on a place: after the block in the middle of the plan's view. */
  const blockInView = useCallback((): Block | undefined => {
    const pane = plan.current;
    if (!pane) return blocksRef.current[blocksRef.current.length - 1];
    const box = pane.getBoundingClientRect();
    const middle = box.top + box.height / 2;
    let best: Block | undefined;
    let distance = Infinity;
    for (const el of pane.querySelectorAll<HTMLElement>('[data-block-id]')) {
      const at = el.getBoundingClientRect();
      const d = Math.abs((at.top + at.bottom) / 2 - middle);
      const block = blocksRef.current.find((candidate) => candidate.id === el.dataset.blockId);
      if (block && d < distance) {
        distance = d;
        best = block;
      }
    }
    return best;
  }, []);

  const addToPlan = useCallback(
    (snapshot: Snapshot, drop: PlanDropTarget | null) => {
      const all = blocksRef.current;
      // Opened from a figure: the new snapshot goes right after that figure.
      const opened = request?.origin.closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
      const anchor = drop ? all.find((block) => block.id === drop.blockId) : (all.find((block) => block.id === opened) ?? blockInView());
      const afterLine = !anchor ? Number.MAX_SAFE_INTEGER : drop?.place === 'before' ? anchor.startLine - 1 : blockEndLine(anchor);
      // Insert now; the still picture is stored as an asset and its reference written in when that is done.
      // The plan's text never holds the picture itself.
      const next = insertSnapshotBlock(markdown, afterLine, { canvas: canvasId, snapshot: snapshot.id });
      const svg = snapshotToSvg(store.getDocument(), snapshot.id);
      if (svg) {
        void assets.put(new Blob([svg], { type: 'image/svg+xml' }), `${snapshot.id}.svg`).then((kept) => {
          if (!('ref' in kept)) return;
          setMarkdown((current) => {
            const found = findSnapshotBlocks(current).find((block) => block.ref.snapshot === snapshot.id && !block.ref.fallback);
            if (!found) return current;
            const lines = current.split('\n');
            lines.splice(found.endLine - 1, 0, `![${snapshot.title.replace(/[\[\]]/g, '')}](${kept.ref})`);
            return lines.join('\n');
          });
        });
      }
      setMarkdown(next);
      const made = findSnapshotBlocks(next).find((found) => found.ref.snapshot === snapshot.id);
      const block = made ? parseMarkdownToBlocks(next).find((candidate) => candidate.startLine === made.startLine) : undefined;
      setArrived(block?.id ?? null);
    },
    [blockInView, canvasId, markdown, request, store],
  );

  useEffect(() => {
    if (!arrived) return;
    const el = plan.current?.querySelector<HTMLElement>(`[data-block-id="${arrived}"]`);
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
    const timer = setTimeout(() => setArrived(null), 1200);
    return () => clearTimeout(timer);
  }, [arrived]);

  /** A plan card goes to its heading in the plan; a web card opens its page. */
  const openReference = useCallback((reference: ReferenceObject) => {
    const { target } = reference;
    if (target.kind === 'web') return void window.open(target.url, '_blank', 'noopener,noreferrer');
    if (target.kind !== 'plan') return;
    const heading = [...(plan.current?.querySelectorAll<HTMLElement>('h1, h2, h3') ?? [])].find((el) => el.textContent?.trim() === target.anchor);
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    heading?.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
    setArrived(heading?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId ?? null);
  }, []);

  /** What an agent would send: the same commands, with the agent as the actor. */
  const agentAddsImage = () => {
    const agent = { kind: 'agent', id: 'demo-agent' } as const;
    const id = createId('image');
    store.dispatch(
      { type: 'add', objects: [{ id, type: 'image', x: 2300, y: 120, w: 344, h: 200, src: CHART_IMAGE, alt: 'Minutes from scan to alert' }] },
      { actor: agent },
    );
    store.dispatch({ type: 'recolor', ids: ['wk'], color: { custom: '#c2410c' } }, { actor: agent });
  };

  return (
    <PeopleProvider people={people}>
      <HtmlItemFacesProvider faces={HOUSE_FACES}>
    <CanvasRegistryProvider registry={registry}>
      <div ref={shell} className="demo-shell pcv">
        <header className="demo-head">
          <h1>Canvas demo</h1>
          <button type="button" className="pcv-btn" aria-pressed={layout === 'plan'} onClick={() => setLayout('plan')}>
            Plan
          </button>
          <button type="button" className="pcv-btn" aria-pressed={layout === 'split'} onClick={() => setLayout('split')}>
            Side by side
          </button>
          <button type="button" className="pcv-btn" aria-pressed={layout === 'canvas'} onClick={() => setLayout('canvas')}>
            Canvas
          </button>
          <button type="button" className="pcv-btn" onClick={agentAddsImage}>
            Agent adds an image
          </button>
          <button type="button" className="pcv-btn" aria-pressed={!available} onClick={() => setAvailable(!available)}>
            Canvas unavailable
          </button>
          <span className="demo-spacer" />
          {behind.length > 0 ? (
            <button type="button" className="pcv-btn" data-update-all onClick={updateAll}>
              {SNAPSHOT_STRINGS.updateAll(behind.length)}
            </button>
          ) : null}
          <span data-count>{snapshotCount(findSnapshotBlocks(markdown).length)}</span>
          <button type="button" className="pcv-btn" aria-pressed={dark} onClick={toggleTheme}>
            Dark
          </button>
        </header>
        <div className="demo-body" data-layout={layout}>
          {layout === 'canvas' ? null : <PlanPane ref={plan} blocks={blocks} arrived={arrived} />}
          {layout !== 'plan' ? (
            // While the canvas is open from a figure, the pane's own copy of it stands down: one canvas on screen, not two.
            <div className="demo-canvas" data-handoff={request ? '' : undefined}>{available ? <CanvasEditor store={store} onAddToPlan={addToPlan} assets={assets} linkPreview={linkPreview} resolvePaste={resolvePaste} onOpenReference={openReference} /> : null}</div>
          ) : null}
        </div>
      </div>
      <CanvasStage request={request} registry={registry} recede={() => shell.current} onClosed={() => setRequest(null)} onAddToPlan={addToPlan} assets={assets} linkPreview={linkPreview} resolvePaste={resolvePaste} onOpenReference={openReference} />
    </CanvasRegistryProvider>
      </HtmlItemFacesProvider>
    </PeopleProvider>
  );
}
