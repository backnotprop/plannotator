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
 *   comments or its math labels, or does not fall back to Mermaid when Pele
 *   cannot draw the fence;
 * - a comment anchored to a diagram part under Mermaid does not restore when
 *   Pele draws the same fence.
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
import { AnnotationType, type Annotation, type Block } from '../types';
import { MERMAID_FINDER } from '../utils/diagram-anchor';
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

/** One source per type Plannotator addresses under Mermaid, with the captured svg the Mermaid slot answers with. */
const CASES = {
  flowchart: { fixture: '06-flowchart-review-decision', source: 'flowchart LR\n  U([Reviewer]) --> D{Approve?}\n  D -->|Yes| M[(Merge)]\n  D -->|No| R[Revise]' },
  sequence: { fixture: '11-sequence-diagram', source: 'sequenceDiagram\n  participant CC as Claude Code\n  participant H as Hook\n  CC->>H: ExitPlanMode\n  H-->>CC: decision' },
  state: { fixture: '08-state-diagram', source: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy: go\n  Busy --> [*]' },
  class: { fixture: '09-class-diagram', source: 'classDiagram\n  class User {\n    +name\n  }\n  User --> Order : places' },
  er: { fixture: '10-er-diagram', source: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places' },
  requirement: { fixture: '15-requirement-diagram', source: 'requirementDiagram\n  requirement r1 {\n    id: 1\n    text: fast\n  }\n  element e1 {\n    type: sim\n  }\n  e1 - satisfies -> r1' },
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
  __setPeleRuntimeLoaderForTests(undefined);
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
  __setPeleRuntimeLoaderForTests(undefined);
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

/** A part the engine draws: Pele's first node group; for Mermaid the first element its finder names. */
function aPart(svg: SVGSVGElement): Element {
  if (engineOf(svg) === 'pele') return svg.querySelector('g.pele-node')!;
  const part = Array.from(svg.querySelectorAll(MERMAID_FINDER.targetSelector)).find((el) => MERMAID_FINDER.targetFromElement(svg, el, svg.id) !== null);
  if (part === undefined) throw new Error('no addressable Mermaid part');
  return part;
}

function pointer(type: string, target: Element): void {
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  target.dispatchEvent(
    new Ctor(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, ...(Ctor !== MouseEvent ? { pointerId: 1 } : {}) } as MouseEventInit),
  );
}

/** Click a part, write a comment, and return the annotation the block made. */
async function commentOnAPart(type: CaseType, mode: DiagramEngineMode): Promise<{ engine: DiagramEngine; annotation: Annotation }> {
  __setDiagramEngineModeForTests(mode);
  const added: Annotation[] = [];
  await mount(<MermaidBlock block={fence(CASES[type].source)} annotations={[]} onAddAnnotation={(a) => added.push(a)} />);
  await waitFor(() => drawn());
  const svg = drawn();
  const part = aPart(svg);
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

  test('a fence with a math label stays on Mermaid', async () => {
    __setDiagramEngineModeForTests('pele-where-safe');
    await mount(<MermaidBlock block={fence('flowchart LR\n  A["$$x^2$$"] --> B')} annotations={[]} onAddAnnotation={noop} />);
    await waitFor(() => drawn());
    expect(engineOf(drawn())).toBe('mermaid');
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

describe.if(hasDom)('diagram engine: comments anchored under Mermaid restore whichever engine draws', () => {
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

  test("a sequence message comment made under Mermaid still restores under 'pele-where-safe' (Mermaid keeps the fence); under 'pele' it is reported unanchored, not lost", async () => {
    const block = fence(CASES.sequence.source);
    // The first message as Mermaid anchors it (`msg-1`, CC -> H) in the captured svg the Mermaid slot serves.
    const message = stored(block, 's1', { v: 1, family: 'sequence', kind: 'edge', id: 'msg-1', from: 'CC', to: 'H', label: 'ExitPlanMode', sourceLine: [6, 6] }, 'ExitPlanMode');
    const results: Record<string, { engine: DiagramEngine; unanchored: readonly string[] }> = {};
    for (const mode of ['pele-where-safe', 'pele'] as const) {
      __setDiagramEngineModeForTests(mode);
      const reports: AnnotationRestoreReport[] = [];
      await mount(<MermaidBlock block={block} annotations={[message]} onRestoreReport={(r) => reports.push(r)} />);
      await waitFor(() => drawn());
      await waitFor(() => expect(reports.length).toBeGreaterThan(0));
      results[mode] = { engine: engineOf(drawn()), unanchored: reports[reports.length - 1]!.unanchored };
      await act(async () => root!.unmount());
      root = null;
    }
    expect(results['pele-where-safe']).toEqual({ engine: 'mermaid', unanchored: [] });
    expect(results.pele).toEqual({ engine: 'pele', unanchored: ['s1'] });
  });
});
