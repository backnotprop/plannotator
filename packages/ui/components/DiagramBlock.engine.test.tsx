/**
 * The diagram engine switch (`utils/diagram-engine.ts`) through the real
 * `MermaidBlock` -> `DiagramBlock` -> viewer path: Mermaid as the host runtime
 * slot serving captured Chromium svgs, Pele for real (it needs no DOM).
 *
 * What regresses if these fail:
 * - the shipped switch no longer draws every fence with Mermaid, or it loads
 *   Pele at all;
 * - `PELE_CAPABILITIES` no longer says what a click on a part does under each
 *   engine (the data a quiet fallback reads);
 * - `'pele-where-safe'` draws with Pele a fence that would lose its part
 *   comments, keeps a math fence off Pele, or does not fall back to Mermaid when Pele
 *   cannot draw the fence;
 * - a click on a part of a flowchart, sequence, state, class, ER or
 *   requirement diagram makes a different anchor (kind, id, ends, label,
 *   source line) under Pele than under Mermaid, or a comment made under one
 *   engine does not restore onto the same part under the other.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AnnotationRestoreReport } from '../hooks/useAnnotationHighlighter';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { loadRealPele, setPeleInBuildForTests } from '../test-setup/pele';
import { AnnotationType, type Annotation, type Block } from '../types';
import { MERMAID_FINDER, type DiagramTarget } from '../utils/diagram-anchor';
import { PELE_FINDER } from '../utils/diagram-anchor-pele';
import { diagramFinder } from '../utils/diagram-render';
import {
  __setDiagramEngineModeForTests,
  DIAGRAM_ENGINE_MODE,
  diagramEngineFor,
  mermaidDiagramTypeOf,
  PELE_CAPABILITIES,
  type DiagramEngine,
  type DiagramEngineMode,
} from '../utils/diagram-engine';
import { __setMermaidRuntimeLoaderForTests, setMermaidRuntime } from '../utils/mermaid';
import { __setPeleRuntimeLoaderForTests, type PeleRuntime } from '../utils/pele';
import { parseMarkdownToBlocks } from '../utils/parser';
import { MermaidBlock } from './MermaidBlock';

const hasDom = typeof document !== 'undefined';
const FIXTURES = join(import.meta.dir, '..', 'test-setup', 'fixtures', 'diagrams');
const CAPTURE_ID = 'diagram-fixture';

/** The fixture's own source (`<fixture>.mmd`), captured with it. */
const sourceOf = (fixture: string): string => readFileSync(join(FIXTURES, `${fixture}.mmd`), 'utf8').replace(/\n+$/u, '');

/** One source per type Plannotator addresses under Mermaid, with the svg Mermaid drew for it (captured in Chromium) that the Mermaid slot answers with. */
const CASES = {
  flowchart: { fixture: '06-flowchart-review-decision', source: 'flowchart LR\n  U([Reviewer]) --> D{Approve?}\n  D -->|Yes| M[(Merge)]\n  D -->|No| R[Revise]' },
  sequence: { fixture: '20-sequence-parts', source: sourceOf('20-sequence-parts') },
  state: { fixture: '21-state-parts', source: sourceOf('21-state-parts') },
  class: { fixture: '22-class-parts', source: sourceOf('22-class-parts') },
  er: { fixture: '23-er-parts', source: sourceOf('23-er-parts') },
  requirement: { fixture: '24-requirement-parts', source: sourceOf('24-requirement-parts') },
} as const;
type CaseType = keyof typeof CASES;
const SVGS = Object.fromEntries(
  Object.entries(CASES).map(([type, c]) => [type, readFileSync(join(FIXTURES, `${c.fixture}.svg`), 'utf8')]),
) as Record<CaseType, string>;

let mermaidRenders = 0;
let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreParser: (() => void) | null = null;
const svgProto = (hasDom ? ((globalThis as { SVGGraphicsElement?: typeof SVGElement }).SVGGraphicsElement ?? SVGElement).prototype : {}) as unknown as Record<string, unknown>;
const elementProto = (hasDom ? Element.prototype : {}) as unknown as Record<string, unknown>;
const saved = { getBBox: svgProto['getBBox'], getScreenCTM: svgProto['getScreenCTM'] };
const noop = (): void => {};

beforeAll(() => {
  if (!hasDom) return;
  restoreParser = installInertDiagramSvgParser();
  setPeleInBuildForTests(true);
  setMermaidRuntime(
    {
      initialize: noop,
      render: (id: string, source: string) => {
        mermaidRenders += 1;
        const type = mermaidDiagramTypeOf(source) as CaseType;
        return Promise.resolve({ svg: SVGS[type].replaceAll(CAPTURE_ID, id) });
      },
    } as unknown as Parameters<typeof setMermaidRuntime>[0],
    'host',
  );
  elementProto['setPointerCapture'] ??= noop;
  elementProto['releasePointerCapture'] ??= noop;
  elementProto['hasPointerCapture'] ??= () => false;
  svgProto['getBBox'] = () => ({ x: 0, y: 0, width: 40, height: 20 });
  svgProto['getScreenCTM'] = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
});

afterAll(() => {
  if (!hasDom) return;
  svgProto['getBBox'] = saved.getBBox;
  svgProto['getScreenCTM'] = saved.getScreenCTM;
  __setMermaidRuntimeLoaderForTests(undefined);
  __setDiagramEngineModeForTests(undefined);
  setPeleInBuildForTests(false);
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
  __setDiagramEngineModeForTests(undefined);
  __setPeleRuntimeLoaderForTests(loadRealPele);
});

function fence(source: string): Block {
  const block = parseMarkdownToBlocks(['# Plan', '', '```mermaid', source, '```', ''].join('\n')).find((b) => b.type === 'code');
  if (block === undefined) throw new Error('no fence');
  return block;
}

async function mount(element: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
}

async function settle(ms = 25): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => void, tries = 80): Promise<void> {
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

function drawn(): SVGSVGElement {
  const svg = host!.querySelector<SVGSVGElement>('[data-diagram-svg] > svg');
  if (svg === null) throw new Error('nothing drawn');
  return svg;
}

const engineOf = (svg: Element): DiagramEngine => (svg.classList.contains('pele') ? 'pele' : 'mermaid');

/** A part the engine draws: for Pele its first node group, else the first element its finder names; for Mermaid the first element its finder names. */
function aPart(svg: SVGSVGElement): Element {
  const finder = engineOf(svg) === 'pele' ? PELE_FINDER : MERMAID_FINDER;
  const part = Array.from(svg.querySelectorAll(finder.targetSelector)).find((el) => finder.targetFromElement(svg, el, svg.id) !== null);
  return part ?? svg.querySelector('g.pele-node') ?? svg;
}

function pointer(type: string, target: Element): void {
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  target.dispatchEvent(
    new Ctor(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, ...(Ctor !== MouseEvent ? { pointerId: 1 } : {}) } as MouseEventInit),
  );
}

/** Click a part (the first one, or the one `pick` names in the drawn svg), write a comment, and return the annotation the block made. */
async function commentOnAPart(type: CaseType, mode: DiagramEngineMode, pick?: (svg: SVGSVGElement) => Element | null | undefined): Promise<{ engine: DiagramEngine; annotation: Annotation }> {
  __setDiagramEngineModeForTests(mode);
  const added: Annotation[] = [];
  await mount(<MermaidBlock block={fence(CASES[type].source)} annotations={[]} onAddAnnotation={(a) => added.push(a)} />);
  await waitFor(() => drawn());
  const svg = drawn();
  const part = pick === undefined ? aPart(svg) : pick(svg);
  if (part === null || part === undefined) throw new Error(`no such part in the ${engineOf(svg)} svg`);
  await act(async () => {
    pointer('pointerdown', part);
    pointer('pointerup', part);
  });
  await waitFor(() => expect(host!.querySelector('[data-diagram-composer] textarea')).not.toBeNull());
  const textarea = host!.querySelector<HTMLTextAreaElement>('[data-diagram-composer] textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'a note');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await waitFor(() => expect(added).toHaveLength(1));
  return { engine: engineOf(svg), annotation: added[0]! };
}

describe.if(hasDom)('diagram engine: the shipped switch is Mermaid', () => {
  test('every fence is drawn by Mermaid, Pele is never imported, and the finder is Mermaid\'s own', async () => {
    expect(DIAGRAM_ENGINE_MODE).toBe('mermaid');
    // The shipped build's own state: Pele not in it (the suite puts it back after).
    setPeleInBuildForTests(false);
    try {
      let peleImports = 0;
      __setPeleRuntimeLoaderForTests(() => {
        peleImports += 1;
        return Promise.reject(new Error('Pele must not load'));
      });
      for (const type of Object.keys(CASES) as CaseType[]) {
        await mount(<MermaidBlock block={fence(CASES[type].source)} annotations={[]} onAddAnnotation={noop} />);
        await waitFor(() => drawn());
        expect(engineOf(drawn())).toBe('mermaid');
        await act(async () => root!.unmount());
        root = null;
      }
      expect(peleImports).toBe(0);
      expect(diagramFinder('mermaid')).toBe(MERMAID_FINDER);
    } finally {
      setPeleInBuildForTests(true);
    }
  });
});

describe.if(hasDom)('diagram engine: what a click on a part does under each engine (PELE_CAPABILITIES)', () => {
  for (const type of Object.keys(CASES) as CaseType[]) {
    for (const engine of ['mermaid', 'pele'] as const) {
      test(`${type} under ${engine}`, async () => {
        const result = await commentOnAPart(type, engine);
        expect(result.engine).toBe(engine);
        const partComment = result.annotation.diagramAnchor !== undefined && result.annotation.diagramAnchor.kind !== 'diagram';
        expect(partComment).toBe(PELE_CAPABILITIES[type][engine].partComments);
      });
    }
  }
});

describe.if(hasDom)("diagram engine: 'pele-where-safe'", () => {
  test('draws with Pele only where no part comment is lost, and the click there still does what the map says', async () => {
    for (const type of Object.keys(CASES) as CaseType[]) {
      const expected = diagramEngineFor(CASES[type].source, { mode: 'pele-where-safe' }).engine;
      const result = await commentOnAPart(type, 'pele-where-safe');
      expect(result.engine).toBe(expected);
      const partComment = result.annotation.diagramAnchor?.kind !== 'diagram';
      expect(partComment).toBe(PELE_CAPABILITIES[type].mermaid.partComments);
      await act(async () => root!.unmount());
      root = null;
    }
  });

  test('a fence with a math label is drawn by Pele, its formula typeset', async () => {
    __setDiagramEngineModeForTests('pele-where-safe');
    await mount(<MermaidBlock block={fence('flowchart LR\n  A["$$x^2$$"] --> B')} annotations={[]} onAddAnnotation={noop} />);
    await waitFor(() => drawn());
    expect(engineOf(drawn())).toBe('pele');
    expect(drawn().querySelector('foreignObject.pele-math[data-pele-tex="x^2"]')).not.toBeNull();
  });

  const failing = (how: 'unsupported' | 'throws'): (() => Promise<PeleRuntime>) => () =>
    Promise.resolve({
      supports: () => Promise.resolve(how !== 'unsupported'),
      render: () => Promise.reject(new Error('Pele failed')),
    });

  for (const how of ['unsupported', 'throws'] as const) {
    test(`a fence Pele cannot draw (${how}) is drawn by Mermaid; under 'pele' the failure is shown`, async () => {
      __setPeleRuntimeLoaderForTests(failing(how));
      __setDiagramEngineModeForTests('pele-where-safe');
      const before = mermaidRenders;
      await mount(<MermaidBlock block={fence(CASES.flowchart.source)} annotations={[]} onAddAnnotation={noop} />);
      await waitFor(() => drawn());
      expect(engineOf(drawn())).toBe('mermaid');
      expect(mermaidRenders).toBeGreaterThan(before);
      await act(async () => root!.unmount());
      root = null;

      __setDiagramEngineModeForTests('pele');
      __setPeleRuntimeLoaderForTests(failing(how));
      await mount(<MermaidBlock block={fence(CASES.flowchart.source)} annotations={[]} onAddAnnotation={noop} />);
      await settle(200);
      expect(host!.querySelector('[data-diagram-svg] > svg')).toBeNull();
    });
  }
});

describe.if(hasDom)('diagram engine: a comment anchored under one engine restores under the other', () => {
  const stored = (block: Block, id: string, anchor: NonNullable<Annotation['diagramAnchor']>, label: string): Annotation => ({
    id,
    blockId: block.id,
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: 'kept',
    originalText: label,
    createdA: 1,
    diagramAnchor: anchor,
  });

  test('a flowchart node, edge and whole-diagram comment made under Mermaid restore under Pele', async () => {
    const block = fence(CASES.flowchart.source);
    const node = stored(block, 'n1', { v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [4, 4] }, 'Approve?');
    const edge = stored(block, 'e1', { v: 1, family: 'flowchart', kind: 'edge', from: 'D', to: 'M', label: 'Yes', sourceLine: [5, 5] }, 'Yes');
    const whole = stored(block, 'w1', { v: 1, family: 'flowchart', kind: 'diagram', label: '', sourceLine: null }, '');
    for (const mode of ['mermaid', 'pele'] as const) {
      __setDiagramEngineModeForTests(mode);
      const reports: AnnotationRestoreReport[] = [];
      await mount(<MermaidBlock block={block} annotations={[node, edge, whole]} onRestoreReport={(r) => reports.push(r)} />);
      await waitFor(() => expect(host!.querySelector('[data-diagram-badge="n1"]')).not.toBeNull());
      expect(engineOf(drawn())).toBe(mode);
      expect(host!.querySelector('[data-diagram-badge="e1"]')).not.toBeNull();
      await waitFor(() => expect(reports.length).toBeGreaterThan(0));
      expect(reports[reports.length - 1]!.unanchored).toEqual([]);
      await act(async () => root!.unmount());
      root = null;
    }
  });

  /** The `n`-th element matching `selector`, or the one whose text is `text`. */
  const nth = (selector: string, n = 0) => (svg: SVGSVGElement) => svg.querySelectorAll(selector)[n];
  const withText = (selector: string, text: string) => (svg: SVGSVGElement) =>
    Array.from(svg.querySelectorAll(selector)).find((el) => (el.textContent ?? '').trim() === text);
  const peleEdge = (id: string) => `g.pele-edge[data-id="${id}"] > path:not(.pele-marker)`;

  interface Part {
    readonly name: string;
    readonly mermaid: (svg: SVGSVGElement) => Element | null | undefined;
    readonly pele: (svg: SVGSVGElement) => Element | null | undefined;
    /** The part, as both engines must name it. */
    readonly target: DiagramTarget;
    /** The source text of the line the anchor points to (null: none). */
    readonly line: string | null;
  }

  const PARTS: Record<Exclude<CaseType, 'flowchart'>, readonly Part[]> = {
    sequence: [
      { name: 'the second message labelled "ping"', mermaid: nth('.messageLine0, .messageLine1', 3), pele: nth('g.pele-message > path:not(.pele-marker)', 3), target: { family: 'sequence', kind: 'edge', id: 'msg-4', from: 'B', to: 'C', label: 'ping' }, line: 'B->>C: ping' },
      { name: 'a self-message', mermaid: nth('.messageLine0, .messageLine1', 2), pele: nth('g.pele-message > path:not(.pele-marker)', 2), target: { family: 'sequence', kind: 'edge', id: 'msg-3', from: 'A', to: 'A', label: 'think' }, line: 'A->>A: think' },
      { name: 'a message whose label needs escaping', mermaid: nth('.messageLine0, .messageLine1', 6), pele: nth('g.pele-message > path:not(.pele-marker)', 6), target: { family: 'sequence', kind: 'edge', id: 'msg-7', from: 'C', to: 'B', label: 'fail "x" < y & z' }, line: 'C-xB: fail "x" < y & z' },
      { name: 'a note', mermaid: nth('rect.note', 0), pele: nth('g.pele-note > rect', 0), target: { family: 'sequence', kind: 'node', id: 'note-1', label: 'shared note' }, line: 'Note over A,B: shared note' },
      { name: 'a frame nested in a loop', mermaid: withText('text.labelText', 'opt'), pele: nth('g.pele-frame-opt > text.pele-frame-kind'), target: { family: 'sequence', kind: 'cluster', id: 'frame-1', label: 'opt [busy]' }, line: 'opt busy' },
      { name: 'an alt frame', mermaid: withText('text.labelText', 'alt'), pele: nth('g.pele-frame-alt > text.pele-frame-kind'), target: { family: 'sequence', kind: 'cluster', id: 'frame-3', label: 'alt [ok]' }, line: 'alt ok' },
      { name: 'a stick-figure actor', mermaid: nth('g.actor-man.actor-top circle'), pele: nth('g.pele-actor[data-id="C"]:not(.pele-actor-footer) circle'), target: { family: 'sequence', kind: 'node', id: 'C', label: 'Charlie Dunn' }, line: 'actor C as Charlie Dunn' },
    ],
    state: [
      { name: 'a state named like a state in another composite', mermaid: nth('g.node[id*="-state-Run2-"]'), pele: nth('g.pele-node[data-id="Run2"] > rect'), target: { family: 'state', kind: 'node', id: 'Run2', label: 'Run' }, line: 'Run2: Run' },
      { name: 'its namesake', mermaid: nth('g.node[id*="-state-Run-"]'), pele: nth('g.pele-node[data-id="Run"] > rect'), target: { family: 'state', kind: 'node', id: 'Run', label: 'Run' }, line: '[*] --> Run' },
      { name: 'a composite state', mermaid: nth('g.statediagram-cluster[id*="-state-Busy-"]'), pele: nth('g.pele-cluster[data-id="Busy"] > text'), target: { family: 'state', kind: 'node', id: 'Busy', label: 'Busy' }, line: 'Idle --> Busy: go' },
      { name: 'a self-transition', mermaid: nth('path[id$="-edge3"]'), pele: nth(peleEdge('edge3')), target: { family: 'state', kind: 'edge', id: 'edge3', label: 'retry' }, line: null },
      { name: 'a transition whose label needs escaping', mermaid: nth('path[id$="-edge7"]'), pele: nth(peleEdge('edge7')), target: { family: 'state', kind: 'edge', id: 'edge7', label: '"x" < y & z' }, line: null },
    ],
    class: [
      { name: 'the second relation from User to Order', mermaid: nth('path[id$="-id_User_Order_2"]'), pele: nth(peleEdge('id_User_Order_2')), target: { family: 'class', kind: 'edge', from: 'User', to: 'Order', label: 'owns' }, line: 'User "1" --> "*" Order : owns' },
      { name: 'the first', mermaid: nth('path[id$="-id_User_Order_1"]'), pele: nth(peleEdge('id_User_Order_1')), target: { family: 'class', kind: 'edge', from: 'User', to: 'Order', label: 'places' }, line: 'User --> Order : places' },
      { name: 'a self-relation', mermaid: nth('path[id$="-id_User_User_4"]'), pele: nth(peleEdge('id_User_User_4')), target: { family: 'class', kind: 'edge', from: 'User', to: 'User', label: 'self' }, line: 'User ..> User : self' },
      { name: 'a generic class', mermaid: nth('g.node[id*="-classId-Order-"]'), pele: nth('g.pele-node[data-id="Order"] > rect'), target: { family: 'class', kind: 'node', id: 'Order', label: 'Order<T>' }, line: 'class Order~T~' },
    ],
    er: [
      { name: 'the second relationship from CUSTOMER to ORDER', mermaid: nth('path[id$="-id_entity-CUSTOMER-0_entity-ORDER-1_1"]'), pele: nth(peleEdge('id_entity-CUSTOMER-0_entity-ORDER-1_1')), target: { family: 'er', kind: 'edge', from: 'CUSTOMER', to: 'ORDER', label: 'returns' }, line: 'CUSTOMER ||--o{ ORDER : returns' },
      { name: 'a self-relationship', mermaid: nth('path[id$="-id_entity-PERSON-3_entity-PERSON-3_3"]'), pele: nth(peleEdge('id_entity-PERSON-3_entity-PERSON-3_3')), target: { family: 'er', kind: 'edge', from: 'PERSON', to: 'PERSON', label: 'is married to' }, line: 'PERSON ||--o| PERSON : "is married to"' },
      { name: 'an entity whose label needs escaping', mermaid: nth('g.node[id*="-entity-p-"]'), pele: nth('g.pele-node[data-id="p"] > rect'), target: { family: 'er', kind: 'node', id: 'p', label: 'Person A & B' }, line: 'p["Person A & B"]' },
    ],
    requirement: [
      { name: 'an element, by its name', mermaid: nth('g.node[id$="-e2"]'), pele: nth('g.pele-node[data-id="e2"] > rect'), target: { family: 'requirement', kind: 'node', id: 'e2', label: 'e2' }, line: 'element e2 {' },
      { name: 'a requirement, by its name', mermaid: nth('g.node[id$="-r2"]'), pele: nth('g.pele-node[data-id="r2"] > rect'), target: { family: 'requirement', kind: 'node', id: 'r2', label: 'r2' }, line: 'functionalRequirement r2 {' },
      { name: 'the second relationship from e1 to r1', mermaid: nth('path[id$="-e1-r1-4"]'), pele: nth(peleEdge('e1-r1-4')), target: { family: 'requirement', kind: 'edge', id: 'e1-r1', label: '<<verifies>>' }, line: null },
      { name: 'the first', mermaid: nth('path[id$="-e1-r1-0"]'), pele: nth(peleEdge('e1-r1-0')), target: { family: 'requirement', kind: 'edge', id: 'e1-r1', label: '<<satisfies>>' }, line: null },
    ],
  };

  const DOC_LINES = (type: CaseType): string[] => ['# Plan', '', '```mermaid', ...CASES[type].source.split('\n')];
  /** A part's identity: what names it, its label and an anchor's version and line aside. */
  const identity = (target: DiagramTarget) => {
    const { label: _label, v: _v, sourceLine: _line, ...rest } = target as DiagramTarget & { v?: number; sourceLine?: unknown };
    return rest;
  };

  /** The part the drawn svg restores `anchor` to, as the drawn engine's finder names it (a Mermaid frame restores to its group: read one of its lines). */
  function restoredPart(anchor: DiagramTarget): DiagramTarget | null {
    const svg = drawn();
    const finder = diagramFinder('mermaid');
    const el = finder.findTarget(svg, anchor, svg.id);
    if (el === null) return null;
    const part = el.matches('g') && el.querySelector(':scope > line.loopLine') !== null ? el.querySelector(':scope > line.loopLine')! : el;
    return finder.targetFromElement(svg, part, svg.id);
  }

  for (const type of Object.keys(PARTS) as Array<keyof typeof PARTS>) {
    test(`${type}: a click on a part makes the same anchor under both engines, and the comment restores onto that part under the other`, async () => {
      const made: Record<DiagramEngine, Annotation[]> = { mermaid: [], pele: [] };
      for (const part of PARTS[type]) {
        for (const engine of ['mermaid', 'pele'] as const) {
          const result = await commentOnAPart(type, engine, part[engine]);
          expect(result.engine).toBe(engine);
          made[engine].push(result.annotation);
          await act(async () => root!.unmount());
          root = null;
        }
        const [underMermaid, underPele] = [made.mermaid.at(-1)!.diagramAnchor!, made.pele.at(-1)!.diagramAnchor!];
        const { v: _v, sourceLine, ...target } = underMermaid;
        expect({ part: part.name, target }).toEqual({ part: part.name, target: part.target });
        expect(underPele).toEqual(underMermaid);
        expect(sourceLine === null ? null : DOC_LINES(type)[sourceLine[0] - 1]?.trim()).toBe(part.line);
      }
      // Each engine restores the comments made under the other, each onto its own part.
      for (const [engine, from] of [['pele', 'mermaid'], ['mermaid', 'pele']] as const) {
        __setDiagramEngineModeForTests(engine);
        const annotations = made[from].map((a, i) => ({ ...a, id: `${from}-${i}` }));
        const reports: AnnotationRestoreReport[] = [];
        await mount(<MermaidBlock block={fence(CASES[type].source)} annotations={annotations} onRestoreReport={(r) => reports.push(r)} />);
        await waitFor(() => expect(host!.querySelector(`[data-diagram-badge="${from}-0"]`)).not.toBeNull());
        expect(engineOf(drawn())).toBe(engine);
        await waitFor(() => expect(reports.length).toBeGreaterThan(0));
        expect(reports.at(-1)!.unanchored).toEqual([]);
        for (const a of annotations) {
          const restored = restoredPart(a.diagramAnchor!);
          expect(restored === null ? null : identity(restored)).toEqual(identity(a.diagramAnchor!));
          expect(restored?.label).toBe(a.diagramAnchor!.label);
        }
        await act(async () => root!.unmount());
        root = null;
      }
    });
  }
});
