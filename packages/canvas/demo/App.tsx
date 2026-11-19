/**
 * The demo page. Development only: no product surface links here.
 *
 *   /                      plan and canvas side by side (a phone gets the plan)
 *   /?bench=plan&n=50      a plan with n snapshots of one 2,000-object canvas
 *   /?bench=canvas&n=2000  the editor alone on an n-object canvas
 *   &theme=dark            start dark
 */
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import type { Block } from '@plannotator/ui/types';
import { blockEndLine, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { CanvasStore } from '../events/store';
import { createId } from '../model/ids';
import type { ReferenceObject, Snapshot } from '../model/types';
import type { PasteResolver } from '../react/references';
import { routeLinkPreview } from '../unfurl/route';
import { CanvasEditor } from '../react/CanvasEditor';
import { findSnapshotBlocks, insertSnapshotBlock } from '../snapshot/block';
import { CanvasStage } from '../snapshot/CanvasStage';
import { createSnapshotDirectiveRenderer } from '../snapshot/directive';
import { snapshotToDataUrl } from '../snapshot/picture';
import type { PlanDropTarget } from '../snapshot/plan-drop';
import { CanvasRegistry, CanvasRegistryProvider } from '../snapshot/registry';
import type { SnapshotOpenRequest } from '../snapshot/SnapshotFigure';
import { indexFor } from '../view/document-index';
import { PlanPane } from './PlanPane';
import { CHART_IMAGE, SAMPLE_CANVAS_ID, SAMPLE_PLAN, createLargeStore, createLongPlan, createSampleStore } from './sample';

const params = new URLSearchParams(location.search);
const bench = params.get('bench');
const count = Number(params.get('n')) || (bench === 'plan' ? 50 : 2000);

const registry = new CanvasRegistry();

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
  directiveRenderer: createSnapshotDirectiveRenderer({ registry, onOpen: (request) => openSnapshot(request) }),
});

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(params.get('theme') === 'dark');
  useEffect(() => {
    document.documentElement.classList.toggle('light', !dark);
  }, [dark]);
  return [dark, () => setDark((value) => !value)];
}

function BenchCanvas() {
  const store = useMemo(() => createLargeStore(count), []);
  useEffect(() => {
    (window as unknown as { __canvas: unknown }).__canvas = { store };
  }, [store]);
  return (
    <div style={{ height: '100%' }}>
      <CanvasEditor store={store} />
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
  const [layout, setLayout] = useState<'split' | 'plan'>(bench === 'plan' ? 'plan' : 'split');
  const plan = useRef<HTMLDivElement>(null);
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
      const fallback = snapshotToDataUrl(store.getDocument(), indexFor(store), snapshot.id);
      const next = insertSnapshotBlock(markdown, afterLine, {
        canvas: canvasId,
        snapshot: snapshot.id,
        ...(fallback ? { fallback: { src: fallback, alt: snapshot.title } } : {}),
      });
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
      <div className="demo-shell pcv">
        <header className="demo-head">
          <h1>Canvas demo</h1>
          <button type="button" className="pcv-btn" aria-pressed={layout === 'split'} onClick={() => setLayout(layout === 'split' ? 'plan' : 'split')}>
            Side by side
          </button>
          <button type="button" className="pcv-btn" onClick={agentAddsImage}>
            Agent adds an image
          </button>
          <button type="button" className="pcv-btn" aria-pressed={!available} onClick={() => setAvailable(!available)}>
            Canvas unavailable
          </button>
          <span className="demo-spacer" />
          <span data-count>{findSnapshotBlocks(markdown).length} snapshots</span>
          <button type="button" className="pcv-btn" aria-pressed={dark} onClick={toggleTheme}>
            Dark
          </button>
        </header>
        <div className="demo-body" data-layout={layout}>
          <PlanPane ref={plan} blocks={blocks} arrived={arrived} />
          {layout === 'split' ? (
            <div className="demo-canvas">{available ? <CanvasEditor store={store} onAddToPlan={addToPlan} linkPreview={linkPreview} resolvePaste={resolvePaste} onOpenReference={openReference} /> : null}</div>
          ) : null}
        </div>
      </div>
      <CanvasStage request={request} registry={registry} onClosed={() => setRequest(null)} onAddToPlan={addToPlan} linkPreview={linkPreview} resolvePaste={resolvePaste} onOpenReference={openReference} />
    </CanvasRegistryProvider>
  );
}
