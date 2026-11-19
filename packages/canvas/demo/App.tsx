/**
 * The demo page. Development only: no product surface links here.
 *
 *   /                      plan and canvas side by side (a phone gets the plan)
 *   /?bench=plan&n=50      a plan with n snapshots of one 2,000-object canvas
 *   /?bench=canvas&n=2000  the editor alone on an n-object canvas (&rich: pictures, HTML items, cards, long notes)
 *   /?view=split           plan and canvas side by side
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
import type { PasteResolver } from '../react/references';
import { pictureResolver } from '../model/assets';
import { routeLinkPreview } from '../react/link-preview';
import { CanvasEditor } from '../react/CanvasEditor';
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
import { PlanPane } from './PlanPane';
import { CHART_IMAGE, SAMPLE_CANVAS_ID, SAMPLE_PLAN, createLargeStore, createLongPlan, createSampleStore } from './sample';

const params = new URLSearchParams(location.search);
const bench = params.get('bench');
const count = Number(params.get('n')) || (bench === 'plan' ? 50 : 2000);

const registry = new CanvasRegistry();

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
  const store = useMemo(() => createLargeStore(count, 0, params.has('rich')), []);
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
  return bench === 'canvas' ? <BenchCanvas /> : <PlanAndCanvas />;
}

function PlanAndCanvas() {
  const [dark, toggleTheme] = useTheme();
  const store = useMemo<CanvasStore>(() => (bench === 'plan' ? createLargeStore(2000, count) : createSampleStore()), []);
  const canvasId = store.getDocument().id;
  const [available, setAvailable] = useState(true);
  const [markdown, setMarkdown] = useState(() => (bench === 'plan' ? createLongPlan(count) : SAMPLE_PLAN));
  const [request, setRequest] = useState<SnapshotOpenRequest | null>(null);
  const [arrived, setArrived] = useState<string | null>(null);
  // The plan alone is the product's case: the canvas is reached through a figure. Side by side is for
  // dragging a snapshot from the board into the plan.
  const [layout, setLayout] = useState<'split' | 'plan'>(params.get('view') === 'split' ? 'split' : 'plan');
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
      { type: 'add', objects: [{ id, type: 'image', x: 960, y: 120, w: 250, h: 110, src: CHART_IMAGE, alt: 'Minutes from scan to alert' }] },
      { actor: agent },
    );
    store.dispatch({ type: 'recolor', ids: ['worker'], color: { custom: '#c2410c' } }, { actor: agent });
  };

  return (
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
          <span data-count>{findSnapshotBlocks(markdown).length} snapshots</span>
          <button type="button" className="pcv-btn" aria-pressed={dark} onClick={toggleTheme}>
            Dark
          </button>
        </header>
        <div className="demo-body" data-layout={layout}>
          <PlanPane ref={plan} blocks={blocks} arrived={arrived} />
          {layout === 'split' ? (
            // While the canvas is open from a figure, the pane's own copy of it stands down: one canvas on screen, not two.
            <div className="demo-canvas" data-handoff={request ? '' : undefined}>{available ? <CanvasEditor store={store} onAddToPlan={addToPlan} assets={assets} linkPreview={linkPreview} resolvePaste={resolvePaste} onOpenReference={openReference} /> : null}</div>
          ) : null}
        </div>
      </div>
      <CanvasStage request={request} registry={registry} recede={() => shell.current} onClosed={() => setRequest(null)} onAddToPlan={addToPlan} assets={assets} linkPreview={linkPreview} resolvePaste={resolvePaste} onOpenReference={openReference} />
    </CanvasRegistryProvider>
  );
}
