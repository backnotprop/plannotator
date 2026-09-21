/**
 * The diagram viewer over a REAL rendered svg with REAL geometry: the svg is
 * mermaid's own output for test-setup/fixtures/diagrams/06-flowchart-
 * review-decision (captured from a headless Chromium, render id
 * "diagram-fixture"); the numbers beside it are the `getBBox()` and
 * `getScreenCTM()` Chromium measured for every element.
 *
 * Three browser APIs happy-dom does not have are stood in, and nothing
 * else: (a) the layout engine's answer for a rendered diagram — the captured
 * svg is handed to the viewer through the package's public host slot
 * (`setMermaidRuntime(runtime, "host")`), so `renderDiagram` runs the real
 * slot code over the real bytes and only the layout step is Chromium's;
 * (b) `SVGGraphicsElement.getBBox` and `getScreenCTM`, installed from the
 * captured numbers, keyed by the element's rendered id suffix; (c) the
 * DOMPurify parse step, which happy-dom cannot host (the scrub still runs).
 * Pointer capture is a no-op stand-in.
 *
 * What regresses if these fail:
 * - rings and badges are placed from stored pixels instead of the current
 *   CTM, so they drift off their nodes on the first zoom or pan;
 * - hover and click describe the wrong part (a marker, a label group, the
 *   background) or the wrong node;
 * - Enter does not hand the host the anchor: the Mermaid id, the label, the
 *   DOCUMENT source line (offset applied), the additional targets;
 * - badge numbers do not follow the `comments` array order;
 * - a comment whose part is gone is not reported unanchored, or one whose
 *   id is gone but whose label survives is (restore step 2 runs first);
 * - a drag pans instead of opening the composer, or a plain click on the
 *   background does not close an open draft;
 * - keyboard zoom loses a manual zoom on the next render;
 * - the Source pane: typing does not preview after the debounce, Save does
 *   not hand the host the draft, a stale answer does not show Reload while
 *   keeping the draft, Discard does not restore the baseline.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { EditorView } from '@codemirror/view';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installInertDiagramSvgParser } from '../../test-setup/diagramSvg';
import type { DiagramAnchor, DiagramTarget } from '../../utils/diagram-anchor';
import { projectElement } from '../../utils/diagram-projection';
import { __setMermaidRuntimeLoaderForTests, setMermaidRuntime } from '../../utils/mermaid';
import { DiagramViewer, type DiagramViewerProps } from './DiagramViewer';
import type { DiagramComment } from './useDiagramComments';
import { PREVIEW_DEBOUNCE_MS, type SaveResult } from './useDiagramSourceDraft';

const hasDom = typeof document !== 'undefined';
const FIXTURES = join(import.meta.dir, '..', '..', 'test-setup', 'fixtures', 'diagrams');
const FIXTURE = '06-flowchart-review-decision';
const CAPTURE_ID = 'diagram-fixture';
const SVG = readFileSync(join(FIXTURES, `${FIXTURE}.svg`), 'utf8');
const SOURCE = ['flowchart LR', '  U([Reviewer]) --> D{Approve?}', '  D -->|Yes| M[(Merge)]', '  D -->|No| R[Revise]', ''].join('\n');
const THEME = { colorTheme: 'plannotator', mode: 'dark' } as const;

interface CapturedElement {
  readonly bbox: { x: number; y: number; width: number; height: number };
  readonly ctm: { a: number; b: number; c: number; d: number; e: number; f: number };
}
const GEOMETRY = JSON.parse(readFileSync(join(FIXTURES, `${FIXTURE}.geometry.json`), 'utf8')) as {
  elements: Record<string, CapturedElement>;
};
/** Captured entries keyed by the id suffix after the render id, so they
 * apply whatever render id the viewer minted. */
const CAPTURED = Object.entries(GEOMETRY.elements).map(([id, entry]) => [id.slice(CAPTURE_ID.length), entry] as const);
function capturedFor(el: Element): CapturedElement | null {
  const found = CAPTURED.find(([suffix]) => el.id.endsWith(suffix));
  return found === undefined ? null : found[1];
}

const NODE_D: DiagramAnchor = { v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [2, 2] };
const NODE_GONE_LABEL_REVISE: DiagramAnchor = { v: 1, family: 'flowchart', kind: 'node', id: 'Gone', label: 'Revise', sourceLine: null };
const NODE_GONE: DiagramAnchor = { v: 1, family: 'flowchart', kind: 'node', id: 'Gone', label: 'Nowhere', sourceLine: null };

function comment(id: string, anchor: DiagramAnchor): DiagramComment {
  return { id, anchor, text: 'a comment', author: 'reviewer' };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreParser: (() => void) | null = null;
let renderCalls: string[] = [];
// happy-dom defines the two geometry methods on SVGGraphicsElement, which
// would shadow a stub on SVGElement; install where the engine defines them.
const svgProto = (hasDom ? ((globalThis as { SVGGraphicsElement?: typeof SVGElement }).SVGGraphicsElement ?? SVGElement).prototype : {}) as unknown as Record<string, unknown>;
const elementProto = (hasDom ? Element.prototype : {}) as unknown as Record<string, unknown>;
const saved = { getBBox: svgProto['getBBox'], getScreenCTM: svgProto['getScreenCTM'] };
const noop = (): void => {};

beforeAll(() => {
  if (!hasDom) return;
  restoreParser = installInertDiagramSvgParser();
  setMermaidRuntime(
    {
      initialize: noop,
      render: (id: string, source: string) => {
        renderCalls.push(source);
        return Promise.resolve({ svg: SVG.replaceAll(CAPTURE_ID, id) });
      },
    } as unknown as Parameters<typeof setMermaidRuntime>[0],
    'host',
  );
  elementProto['setPointerCapture'] ??= noop;
  elementProto['releasePointerCapture'] ??= noop;
  elementProto['hasPointerCapture'] ??= () => false;
  svgProto['getBBox'] = function (this: Element) {
    // The svg root's content bounds: the whole-diagram ring.
    if (this.tagName.toLowerCase() === 'svg') return { x: 0, y: 0, width: 452, height: 182 };
    const captured = capturedFor(this);
    if (captured === null) throw new Error(`no captured geometry for ${this.id}`);
    return { ...captured.bbox };
  };
  svgProto['getScreenCTM'] = function (this: Element) {
    if (this.tagName.toLowerCase() === 'svg') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    return capturedFor(this)?.ctm ?? null;
  };
});

afterAll(() => {
  if (!hasDom) return;
  svgProto['getBBox'] = saved.getBBox;
  svgProto['getScreenCTM'] = saved.getScreenCTM;
  __setMermaidRuntimeLoaderForTests(undefined);
  restoreParser?.();
});

afterEach(async () => {
  if (root !== null) {
    const finished = root;
    await act(async () => {
      finished.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
  renderCalls = [];
});

async function mount(element: React.ReactElement): Promise<{ rerender: (next: React.ReactElement) => Promise<void> }> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
  return {
    rerender: async (next) => {
      await act(async () => {
        root!.render(next);
      });
    },
  };
}

async function settle(ms = 25): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => void, tries = 40): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < tries; i += 1) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
}

function q<T extends Element = HTMLElement>(selector: string): T {
  const el = host!.querySelector<T>(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el;
}

function pointer(type: string, target: Element, init: { x: number; y: number; shift?: boolean; mod?: boolean; pointerId?: number }): void {
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  const event = new Ctor(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x,
    clientY: init.y,
    button: 0,
    shiftKey: init.shift ?? false,
    // The platform modifier, whichever platform happy-dom reports.
    metaKey: init.mod ?? false,
    ctrlKey: init.mod ?? false,
    ...(Ctor !== MouseEvent ? { pointerId: init.pointerId ?? 1 } : {}),
  } as MouseEventInit);
  target.dispatchEvent(event);
}

async function clickPart(target: Element, shift = false): Promise<void> {
  await act(async () => {
    pointer('pointerdown', target, { x: 10, y: 10, shift });
    pointer('pointerup', target, { x: 10, y: 10, shift });
  });
}

function viewer(props: Partial<DiagramViewerProps> & { comments?: readonly DiagramComment[] }): React.ReactElement {
  return <DiagramViewer kind="mermaid" source={SOURCE} theme={THEME} comments={[]} renderId="t" {...props} />;
}

function nodeD(): Element {
  return q('[id$="-flowchart-D-1"]');
}

describe.if(hasDom)('restore and paint', () => {
  test('paints rings and numbered badges where Chromium put the parts, numbers from array order, and reports the gone ones', async () => {
    const unanchored: string[][] = [];
    const rows = [comment('a1', NODE_D), comment('a2', NODE_GONE_LABEL_REVISE), comment('a3', NODE_GONE)];
    const onUnanchoredChange = (ids: ReadonlySet<string>) => unanchored.push([...ids].sort());
    const { rerender } = await mount(viewer({ comments: rows, onUnanchoredChange }));

    await waitFor(() => {
      expect(q('[data-diagram-badge="a1"]').textContent).toBe('1');
      expect(q('[data-diagram-badge="a2"]').textContent).toBe('2');
    });
    expect(host!.querySelector('[data-diagram-badge="a3"]')).toBeNull();
    expect(unanchored[unanchored.length - 1]).toEqual(['a3']);

    // The ring for node D: Chromium measured the node's box at
    // (-58.76, -59.26, 118.52 x 118.52) in user units under a CTM that
    // translates by (207.36, 93.59) and scales by 0.99996, so the screen
    // rectangle is (148.6, 34.3, 118.5 x 118.5); the ring pads it by 3px.
    const ring = q<HTMLElement>('[data-diagram-mark="a1"] > div');
    expect(Number.parseFloat(ring.style.left)).toBeCloseTo(148.6 - 3, 0);
    expect(Number.parseFloat(ring.style.top)).toBeCloseTo(34.3 - 3, 0);
    expect(Number.parseFloat(ring.style.width)).toBeCloseTo(118.5 + 6, 0);
    expect(Number.parseFloat(ring.style.height)).toBeCloseTo(118.5 + 6, 0);
    // The label fallback ring (a2) sits on node R, not on D.
    const ringR = q<HTMLElement>('[data-diagram-mark="a2"] > div');
    expect(Number.parseFloat(ringR.style.left)).toBeCloseTo(339.3 - 3, 0);
    expect(Number.parseFloat(ringR.style.top)).toBeCloseTo(120.8 - 3, 0);

    // Array order is the number: swap the first two rows.
    await rerender(viewer({ comments: [rows[1]!, rows[0]!, rows[2]!], onUnanchoredChange }));
    await waitFor(() => {
      expect(q('[data-diagram-badge="a2"]').textContent).toBe('1');
      expect(q('[data-diagram-badge="a1"]').textContent).toBe('2');
    });
  });

  test('clicking a badge selects that comment', async () => {
    const selected: Array<string | null> = [];
    await mount(viewer({ comments: [comment('a1', NODE_D)], onSelectComment: (id) => selected.push(id) }));
    await waitFor(() => expect(host!.querySelector('[data-diagram-badge="a1"]')).not.toBeNull());
    await act(async () => {
      q<HTMLButtonElement>('[data-diagram-badge="a1"]').click();
    });
    expect(selected).toEqual(['a1']);
  });
});

describe.if(hasDom)('the projection', () => {
  test('reprojects from the live CTM (a 2x zoom doubles the rectangle) and answers null with no geometry', async () => {
    await mount(viewer({}));
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    const node = nodeD() as SVGGraphicsElement;
    const base = projectElement(node, { left: 0, top: 0 })!;
    expect(base.left).toBeCloseTo(148.6, 0);
    expect(base.width).toBeCloseTo(118.5, 0);
    const captured = capturedFor(node)!;
    const zoomed = { ...captured.ctm, a: captured.ctm.a * 2, d: captured.ctm.d * 2, e: captured.ctm.e * 2, f: captured.ctm.f * 2 };
    const original = node.getScreenCTM;
    (node as unknown as Record<string, unknown>)['getScreenCTM'] = () => zoomed;
    const doubled = projectElement(node, { left: 0, top: 0 })!;
    expect(doubled.left).toBeCloseTo(base.left * 2, 0);
    expect(doubled.width).toBeCloseTo(base.width * 2, 0);
    (node as unknown as Record<string, unknown>)['getScreenCTM'] = () => null;
    expect(projectElement(node, { left: 0, top: 0 })).toBeNull();
    (node as unknown as Record<string, unknown>)['getScreenCTM'] = original;
  });
});

describe.if(hasDom)('hover, click, compose', () => {
  test('a plain mouse-over highlights nothing; the ring under the pointer appears only with the platform modifier held', async () => {
    // Owner feedback: hover targeting read as messy and fought the pan
    // hand, so nothing paints on a plain move.
    await mount(viewer({ onCreateComment: noop }));
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    await act(async () => {
      pointer('pointermove', nodeD(), { x: 10, y: 10 });
    });
    await settle();
    expect(host!.querySelector('[data-diagram-hover]')).toBeNull();
    await act(async () => {
      pointer('pointermove', nodeD(), { x: 10, y: 10, mod: true });
    });
    await waitFor(() => expect(host!.querySelector('[data-diagram-hover]')).not.toBeNull());
    expect(q('[data-diagram-hover]').textContent).toContain('Approve?');
    expect(q('[data-diagram-hover]').textContent).toContain('node D');
    await act(async () => {
      pointer('pointermove', nodeD(), { x: 11, y: 10 });
    });
    await waitFor(() => expect(host!.querySelector('[data-diagram-hover]')).toBeNull());
  });

  test('a click on an edge\'s widened hit path, or on its label, opens the composer for that edge', async () => {
    // Owner feedback: a 1–2 px stroke was only catchable at random spots,
    // and the label painted over the edge (where a person clicks it) was
    // not a target at all.
    const created: Array<{ anchor: DiagramAnchor }> = [];
    await mount(viewer({ onCreateComment: (anchor) => { created.push({ anchor }); } }));
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    const edges = Array.from(host!.querySelectorAll('path.flowchart-link'));
    const hits = Array.from(host!.querySelectorAll('[data-diagram-hit-layer] > [data-diagram-hit]'));
    expect(hits.length).toBe(edges.length);
    expect(hits.length).toBe(3);
    // The pointer lands on the widened path (what a click 6 px off the
    // visible stroke hits in a browser); the canvas resolves the edge.
    const edgeDM = q('[id$="-L_D_M_0"]');
    await clickPart(hits[edges.indexOf(edgeDM)]!);
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
    expect(q('[data-diagram-composer]').textContent).toContain('edge D → M');
    const textarea = q<HTMLTextAreaElement>('[data-diagram-composer] textarea');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'on the edge');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.anchor).toMatchObject({ kind: 'edge', from: 'D', to: 'M', label: 'Yes' });

    // The label "No" is the D → R edge.
    const labelNo = Array.from(host!.querySelectorAll('g.edgeLabel')).find((g) => g.textContent?.trim() === 'No')!;
    await clickPart(labelNo.querySelector('p, span, text') ?? labelNo);
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
    expect(q('[data-diagram-composer]').textContent).toContain('edge D → R');
  });

  test('where an edge meets a node the node wins: targets resolve by priority over everything under the pointer', async () => {
    // The hit layer sits above the nodes, so at an edge's end both are under
    // the pointer; the topmost element alone would pick the edge.
    await mount(viewer({ onCreateComment: noop }));
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    const hit = host!.querySelector('[data-diagram-hit-layer] > [data-diagram-hit]')!;
    const doc = host!.ownerDocument as Document & { elementsFromPoint?: (x: number, y: number) => Element[] };
    const original = doc.elementsFromPoint;
    doc.elementsFromPoint = () => [hit, nodeD().querySelector('polygon, rect, path') ?? nodeD(), q('[data-diagram-canvas]')];
    try {
      await clickPart(hit);
      await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
      expect(q('[data-diagram-composer]').textContent).toContain('node D');
    } finally {
      doc.elementsFromPoint = original;
    }
  });

  test('a press on the zoom strip over a node opens nothing; 1 px outside it the node opens the composer', async () => {
    // Owner report: the controls are painted over the canvas and are not in
    // the svg, so the `elementsFromPoint` walk stepped past them to the part
    // behind — pressing Zoom out over a node opened the composer on it.
    await mount(viewer({ onCreateComment: noop }));
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    // Fit is the control to press here: it is already the current viewport
    // after mount, so a press that (wrongly) reaches the diagram cannot also
    // churn the transform and make this test about something else.
    const fitButton = q<HTMLButtonElement>('[data-diagram-zoom-strip] [aria-label="Fit diagram"]');
    const nodeShape = nodeD().querySelector('polygon, rect, path') ?? nodeD();
    const canvas = q('[data-diagram-canvas]');
    const doc = host!.ownerDocument as Document & { elementsFromPoint?: (x: number, y: number) => Element[] };
    const original = doc.elementsFromPoint;
    // What Chromium reports for the two points: inside the strip the button
    // is topmost with the node still under it; 1 px outside, only the node.
    const STRIP_X = 300;
    doc.elementsFromPoint = (x: number) => (x === STRIP_X ? [fitButton, nodeShape, canvas] : [nodeShape, canvas]);
    try {
      await act(async () => {
        pointer('pointerdown', fitButton, { x: STRIP_X, y: 200 });
        pointer('pointerup', fitButton, { x: STRIP_X, y: 200 });
      });
      await settle();
      expect(host!.querySelectorAll('[data-diagram-composer]').length).toBe(0);

      await act(async () => {
        pointer('pointerdown', nodeShape, { x: STRIP_X - 1, y: 200 });
        pointer('pointerup', nodeShape, { x: STRIP_X - 1, y: 200 });
      });
      await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
      expect(q('[data-diagram-composer]').textContent).toContain('node D');
    } finally {
      doc.elementsFromPoint = original;
    }
  });

  test('a click that resolves no part comments on the WHOLE diagram, so a click never does nothing', async () => {
    const created: Array<{ anchor: DiagramAnchor }> = [];
    const { rerender } = await mount(viewer({ sourceLineOffset: 10, onCreateComment: (anchor) => { created.push({ anchor }); } }));
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    await clickPart(q('[data-diagram-svg] > svg'));
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
    expect(q('[data-diagram-composer]').textContent).toContain('whole diagram');
    const textarea = q<HTMLTextAreaElement>('[data-diagram-composer] textarea');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'the whole flow is backwards');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(created).toHaveLength(1));
    // No id; the label is the first source line; the range is the whole
    // source, offset into the host's document.
    expect(created[0]!.anchor).toEqual({ v: 1, family: 'flowchart', kind: 'diagram', label: 'flowchart LR', sourceLine: [11, 14] });

    // Restored, it rings the content bounds and is never unanchored.
    const unanchored: string[][] = [];
    await rerender(viewer({ comments: [comment('w1', created[0]!.anchor)], onUnanchoredChange: (ids) => unanchored.push([...ids]) }));
    await waitFor(() => expect(host!.querySelector('[data-diagram-badge="w1"]')).not.toBeNull());
    expect(unanchored[unanchored.length - 1] ?? []).toEqual([]);
  });

  test('click opens the composer at the part; Enter hands the host the anchor with the document line offset and selects nothing else', async () => {
    const created: Array<{ anchor: DiagramAnchor; text: string; additional: readonly DiagramTarget[] }> = [];
    await mount(
      viewer({
        sourceLineOffset: 10,
        onCreateComment: (anchor, text, additional) => {
          created.push({ anchor, text, additional });
        },
      }),
    );
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    await clickPart(nodeD());
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
    const composer = q('[data-diagram-composer]');
    expect(composer.textContent).toContain('Approve?');
    expect(composer.textContent).toContain('node D');
    // The declaring line of D in the source is 2; the host's offset makes
    // it a document line.
    expect(composer.textContent).toContain('line 12');
    const textarea = q<HTMLTextAreaElement>('[data-diagram-composer] textarea');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'Rename this step');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.anchor).toEqual({ v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [12, 12] });
    expect(created[0]!.text).toBe('Rename this step');
    expect(created[0]!.additional).toEqual([]);
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).toBeNull());
  });

  test('shift-click adds an edge to the one draft when the host allows extra targets; the default cap of 0 refuses', async () => {
    const created: Array<{ additional: readonly DiagramTarget[] }> = [];
    const { rerender } = await mount(
      viewer({
        maxAdditionalTargets: 16,
        onCreateComment: (_anchor, _text, additional) => {
          created.push({ additional });
        },
      }),
    );
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    await clickPart(nodeD());
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
    await clickPart(q('[id$="-L_D_M_0"]'), true);
    await waitFor(() => expect(q('[data-diagram-composer]').textContent).toContain('+1 more'));
    const textarea = q<HTMLTextAreaElement>('[data-diagram-composer] textarea');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'both');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.additional).toEqual([{ family: 'flowchart', kind: 'edge', from: 'D', to: 'M', label: 'Yes' }]);

    // The default cap: a shift-click extends nothing.
    await rerender(viewer({ onCreateComment: noop }));
    await clickPart(nodeD());
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
    await clickPart(q('[id$="-L_D_M_0"]'), true);
    await settle();
    expect(q('[data-diagram-composer]').textContent).not.toContain('more');
  });

  test('a 20 px press is a pan and never opens the composer; a 2 px one is a click; a plain click on the background closes the draft; Escape closes it too', async () => {
    await mount(viewer({ onCreateComment: noop }));
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    const wrapper = q<HTMLElement>('[data-diagram-svg]');
    const before = wrapper.style.transform;
    // A 20 px drag is a pan, never a click.
    await act(async () => {
      pointer('pointerdown', nodeD(), { x: 10, y: 10 });
      pointer('pointermove', nodeD(), { x: 30, y: 10 });
      pointer('pointerup', nodeD(), { x: 30, y: 10 });
    });
    await settle();
    expect(host!.querySelector('[data-diagram-composer]')).toBeNull();
    expect(wrapper.style.transform).not.toBe(before);
    expect(wrapper.style.transform).toContain('translate(20px, 0px)');
    // A slightly moving press (under the 4 px threshold) is still a click.
    await act(async () => {
      pointer('pointerdown', nodeD(), { x: 10, y: 10 });
      pointer('pointermove', nodeD(), { x: 12, y: 11 });
      pointer('pointerup', nodeD(), { x: 12, y: 11 });
    });
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
    await act(async () => {
      q('[data-diagram-canvas]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).toBeNull());

    await clickPart(nodeD());
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
    await clickPart(q('[data-diagram-canvas]'));
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).toBeNull());

    await clickPart(nodeD());
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
    await act(async () => {
      q('[data-diagram-canvas]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).toBeNull());
  });

  test('refuses honestly when the host disables commenting: the reason, no textarea; and opens nothing with no handler at all', async () => {
    const { rerender } = await mount(viewer({ commentingDisabledReason: 'You have view access here.' }));
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    await clickPart(nodeD());
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
    expect(q('[data-diagram-composer]').textContent).toContain('You have view access here.');
    expect(host!.querySelector('[data-diagram-composer] textarea')).toBeNull();

    await rerender(viewer({}));
    await settle();
    await clickPart(nodeD());
    await settle();
    expect(host!.querySelector('[data-diagram-composer]')).toBeNull();
  });

  test('keyboard zoom and fit act on the canvas transform; a re-render keeps a manual zoom until the next fit', async () => {
    const { rerender } = await mount(viewer({}));
    await waitFor(() => expect(host!.querySelector('[data-diagram-canvas]')).not.toBeNull());
    const canvas = q('[data-diagram-canvas]');
    const wrapper = q<HTMLElement>('[data-diagram-svg]');
    await act(async () => {
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
    });
    expect(wrapper.style.transform).toContain('scale(1.25)');
    await rerender(viewer({ source: SOURCE + '  R --> Q[Queued]\n', comments: [comment('a1', NODE_D)] }));
    await waitFor(() => expect(host!.querySelector('[data-diagram-badge="a1"]')).not.toBeNull());
    expect(wrapper.style.transform).toContain('scale(1.25)');
    await act(async () => {
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    });
    expect(wrapper.style.transform).toContain('scale(1)');
  });
});

describe.if(hasDom)('the Source pane', () => {
  function editor(): EditorView {
    const view = EditorView.findFromDOM(q('[data-diagram-source-editor] .cm-editor'));
    if (view === null) throw new Error('no editor');
    return view;
  }

  async function type(text: string): Promise<void> {
    await act(async () => {
      const view = editor();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    });
  }

  test('no onSave means no pane; with onSave the pane previews the draft, saves it, and Discard restores the baseline', async () => {
    const saves: string[] = [];
    const onSave = async (source: string): Promise<SaveResult> => {
      saves.push(source);
      return { status: 'ok' };
    };
    const { rerender } = await mount(viewer({ sourceOpen: true }));
    await settle();
    expect(host!.querySelector('[data-diagram-source-pane]')).toBeNull();

    await rerender(viewer({ sourceOpen: true, onSave }));
    await waitFor(() => expect(host!.querySelector('[data-diagram-source-pane]')).not.toBeNull());
    expect(editor().state.doc.toString()).toBe(SOURCE);
    const rendersBefore = renderCalls.length;

    await type(SOURCE + '  R --> Q[Queued]\n');
    await waitFor(() => expect(host!.querySelector('[data-diagram-draft-state]')).not.toBeNull());
    // The preview lands after the debounce, once, with the draft.
    await settle(PREVIEW_DEBOUNCE_MS + 40);
    await waitFor(() => expect(renderCalls.length).toBe(rendersBefore + 1));
    expect(renderCalls[renderCalls.length - 1]).toContain('Q[Queued]');

    const save = Array.from(host!.querySelectorAll<HTMLButtonElement>('[data-diagram-source-pane] button')).find((b) => b.textContent === 'Save')!;
    await act(async () => {
      save.click();
    });
    await waitFor(() => expect(saves).toEqual([SOURCE + '  R --> Q[Queued]\n']));
    await waitFor(() => expect(host!.querySelector('[data-diagram-draft-state]')).toBeNull());

    await type('flowchart LR\n  A --> B\n');
    await waitFor(() => expect(host!.querySelector('[data-diagram-draft-state]')).not.toBeNull());
    const discard = Array.from(host!.querySelectorAll<HTMLButtonElement>('[data-diagram-source-pane] button')).find((b) => b.textContent === 'Discard')!;
    await act(async () => {
      discard.click();
    });
    await waitFor(() => expect(editor().state.doc.toString()).toBe(SOURCE + '  R --> Q[Queued]\n'));
    expect(host!.querySelector('[data-diagram-draft-state]')).toBeNull();
  });

  test('a stale answer shows Reload, holds Save and keeps the draft; Reload adopts the newer text as the baseline', async () => {
    const NEWER = 'flowchart LR\n  X --> Y\n';
    const onSave = async (): Promise<SaveResult> => ({ status: 'stale', currentSource: NEWER });
    await mount(viewer({ sourceOpen: true, onSave }));
    await waitFor(() => expect(host!.querySelector('[data-diagram-source-pane]')).not.toBeNull());
    await type(SOURCE + '  R --> Q\n');
    const buttons = () => Array.from(host!.querySelectorAll<HTMLButtonElement>('[data-diagram-source-pane] button'));
    await waitFor(() => expect(buttons().find((b) => b.textContent === 'Save')!.disabled).toBe(false));
    await act(async () => {
      buttons().find((b) => b.textContent === 'Save')!.click();
    });
    await waitFor(() => expect(host!.querySelector('[data-diagram-reload-strip]')).not.toBeNull());
    expect(buttons().find((b) => b.textContent === 'Save')!.disabled).toBe(true);
    expect(editor().state.doc.toString()).toBe(SOURCE + '  R --> Q\n');
    await act(async () => {
      buttons().find((b) => b.textContent === 'Reload')!.click();
    });
    await waitFor(() => expect(host!.querySelector('[data-diagram-reload-strip]')).toBeNull());
    // The dirty draft stays; the baseline moved, so Save is live again.
    expect(editor().state.doc.toString()).toBe(SOURCE + '  R --> Q\n');
    expect(buttons().find((b) => b.textContent === 'Save')!.disabled).toBe(false);
    await act(async () => {
      buttons().find((b) => b.textContent === 'Discard')!.click();
    });
    await waitFor(() => expect(editor().state.doc.toString()).toBe(NEWER));
  });

  test('readOnlySource shows the pane without Save', async () => {
    const onSave = async (): Promise<SaveResult> => ({ status: 'ok' });
    await mount(viewer({ sourceOpen: true, onSave, readOnlySource: true }));
    await waitFor(() => expect(host!.querySelector('[data-diagram-source-pane]')).not.toBeNull());
    expect(q('[data-diagram-source-pane]').textContent).toContain('Read only');
    expect(Array.from(host!.querySelectorAll('[data-diagram-source-pane] button')).map((b) => b.textContent)).not.toContain('Save');
  });
});

describe.if(hasDom)('the canvas as a citizen of the page', () => {
  test('inline it lets a finger scroll the page (never touch-none); a host that owns the screen opts in; the zoom strip never prints', async () => {
    // Review blocker: `touch-none` on a diagram up to 65vh tall swallowed
    // every touch drag, so a phone reader could not scroll past it.
    const { rerender } = await mount(viewer({}));
    await waitFor(() => expect(host!.querySelector('[data-diagram-canvas]')).not.toBeNull());
    expect(q('[data-diagram-canvas]').classList.contains('touch-none')).toBe(false);
    expect(q('[data-diagram-canvas]').classList.contains('touch-pan-y')).toBe(true);
    expect(q('[data-diagram-zoom-strip]').hasAttribute('data-print-hide')).toBe(true);
    await rerender(viewer({ canvasClassName: 'touch-none' }));
    expect(q('[data-diagram-canvas]').classList.contains('touch-none')).toBe(true);
    expect(q('[data-diagram-canvas]').classList.contains('touch-pan-y')).toBe(false);
  });

  test('browser chords pass through: Mod+0, Mod+-, Alt+Arrow are neither handled nor swallowed', async () => {
    await mount(viewer({}));
    await waitFor(() => expect(host!.querySelector('[data-diagram-canvas]')).not.toBeNull());
    const canvas = q('[data-diagram-canvas]');
    const wrapper = q<HTMLElement>('[data-diagram-svg]');
    const before = wrapper.style.transform;
    for (const init of [{ key: '0', metaKey: true }, { key: '-', ctrlKey: true }, { key: 'ArrowLeft', altKey: true }, { key: '+', metaKey: true }]) {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      await act(async () => {
        canvas.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(wrapper.style.transform).toBe(before);
    // The bare key still works.
    await act(async () => {
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true, cancelable: true }));
    });
    expect(wrapper.style.transform).not.toBe(before);
  });

  test('the modifier-gated ring disarms on the modifier\'s release, on any other key, and on window blur', async () => {
    await mount(viewer({ onCreateComment: noop }));
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    const arm = async () => {
      await act(async () => {
        pointer('pointermove', nodeD(), { x: 10, y: 10, mod: true });
      });
      await waitFor(() => expect(host!.querySelector('[data-diagram-hover]')).not.toBeNull());
    };
    for (const disarm of [
      () => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' })); window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' })); },
      () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, ctrlKey: true })),
      () => window.dispatchEvent(new Event('blur')),
    ]) {
      await arm();
      await act(async () => {
        disarm();
      });
      await waitFor(() => expect(host!.querySelector('[data-diagram-hover]')).toBeNull());
    }
  });

  test('a finger gets a wider click threshold than a mouse: an 8 px wobble is still a tap', async () => {
    await mount(viewer({ onCreateComment: noop }));
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    const touch = (type: string, x: number) => {
      const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
      const event = new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: 10, button: 0, ...(Ctor !== MouseEvent ? { pointerId: 7, pointerType: 'touch' } : {}) } as MouseEventInit);
      if ((event as PointerEvent).pointerType !== 'touch') Object.defineProperty(event, 'pointerType', { value: 'touch' });
      nodeD().dispatchEvent(event);
    };
    await act(async () => {
      touch('pointerdown', 10);
      touch('pointermove', 18);
      touch('pointerup', 18);
    });
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
  });
});
