/**
 * The other side of DiagramBlock.restoreReportLoop.test.tsx: with the host's
 * onRestoreReport read through a ref, a REAL change (new annotations, a
 * document change, a callback appearing) must still produce a report, and it
 * must reach the host's LATEST callback, not the one from first mount (a
 * stale closure would put an old file's or an old render's state back).
 * DOM-gated (DOM_TESTS=1). Outside act(), bounded waits (as the PR's test).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AnnotationRestoreReport } from '../hooks/useAnnotationHighlighter';
import { AnnotationType, type Annotation } from '../types';
import { drawMermaidFencesWithMermaid } from '../test-setup/mermaidEngine';

drawMermaidFencesWithMermaid();

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;
const diagramSvg = hasDom ? await import('../test-setup/diagramSvg') : null;
const mermaid = hasDom ? await import('../utils/mermaid') : null;

const FIXTURES = join(import.meta.dir, '..', 'test-setup', 'fixtures', 'diagrams');
const CAPTURE_ID = 'diagram-fixture';
const SVG = readFileSync(join(FIXTURES, '06-flowchart-review-decision.svg'), 'utf8');
const GEOMETRY = JSON.parse(readFileSync(join(FIXTURES, '06-flowchart-review-decision.geometry.json'), 'utf8')) as {
  elements: Record<string, { bbox: { x: number; y: number; width: number; height: number }; ctm: DOMMatrix }>;
};
const CAPTURED = Object.entries(GEOMETRY.elements).map(([id, entry]) => [id.slice(CAPTURE_ID.length), entry] as const);

const MARKDOWN = ['# Harbor rollout', '', '```mermaid', 'flowchart LR', '  U([Reviewer]) --> D{Approve?}', '  D -->|Yes| M[(Merge)]', '  D -->|No| R[Revise]', '```', '', 'After the diagram.'].join('\n');

const svgProto = (hasDom ? ((globalThis as { SVGGraphicsElement?: typeof SVGElement }).SVGGraphicsElement ?? SVGElement).prototype : {}) as unknown as Record<string, unknown>;
const elementProto = (hasDom ? Element.prototype : {}) as unknown as Record<string, unknown>;
const savedProto = { getBBox: svgProto['getBBox'], getScreenCTM: svgProto['getScreenCTM'] };
const actFlag = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const savedActFlag = actFlag.IS_REACT_ACT_ENVIRONMENT;
const savedConsoleError = console.error;
let restoreParser: (() => void) | null = null;
const noop = (): void => {};

beforeAll(() => {
  if (!hasDom) return;
  restoreParser = diagramSvg!.installInertDiagramSvgParser();
  mermaid!.setMermaidRuntime(
    { initialize: noop, render: (id: string) => Promise.resolve({ svg: SVG.replaceAll(CAPTURE_ID, id) }) } as unknown as Parameters<typeof import('../utils/mermaid').setMermaidRuntime>[0],
    'host',
  );
  elementProto['setPointerCapture'] ??= noop;
  elementProto['releasePointerCapture'] ??= noop;
  elementProto['hasPointerCapture'] ??= () => false;
  svgProto['getBBox'] = function (this: Element) {
    if (this.tagName.toLowerCase() === 'svg') return { x: 0, y: 0, width: 452, height: 182 };
    const found = CAPTURED.find(([suffix]) => this.id.endsWith(suffix));
    return found ? { ...found[1].bbox } : { x: 0, y: 0, width: 0, height: 0 };
  };
  svgProto['getScreenCTM'] = function (this: Element) {
    if (this.tagName.toLowerCase() === 'svg') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    return CAPTURED.find(([suffix]) => this.id.endsWith(suffix))?.[1].ctm ?? null;
  };
  actFlag.IS_REACT_ACT_ENVIRONMENT = false;
  console.error = noop;
});

afterAll(() => {
  if (!hasDom) return;
  console.error = savedConsoleError;
  actFlag.IS_REACT_ACT_ENVIRONMENT = savedActFlag;
  svgProto['getBBox'] = savedProto.getBBox;
  svgProto['getScreenCTM'] = savedProto.getScreenCTM;
  mermaid!.__setMermaidRuntimeLoaderForTests(undefined);
  restoreParser?.();
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (read()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Tagged = AnnotationRestoreReport & { gen: number };
interface HostState { markdown: string; annotations: Annotation[]; gen: number; withCallback: boolean }

/** Inbox-shaped host whose callback closes over `gen` (host state), and whose state the test can change. */
function mount(initial: HostState) {
  const reports: Tagged[] = [];
  let renders = 0;
  let set: ((next: HostState) => void) | null = null;
  const Viewer = viewerModule!.Viewer;
  const blocksFor = new Map<string, ReturnType<typeof parserModule.parseMarkdownToBlocks>>();
  const blocksOf = (md: string) => {
    if (!blocksFor.has(md)) blocksFor.set(md, parserModule!.parseMarkdownToBlocks(md));
    return blocksFor.get(md)!;
  };
  function Host() {
    const [state, setState] = useState(initial);
    const [, setUnanchored] = useState<ReadonlySet<string>>(new Set());
    set = setState;
    renders += 1;
    const gen = state.gen;
    return (
      <Viewer
        blocks={blocksOf(state.markdown)}
        markdown={state.markdown}
        annotations={state.annotations}
        onAddAnnotation={noop}
        onSelectAnnotation={noop}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        onRestoreReport={state.withCallback ? (report) => {
          reports.push({ ...report, gen });
          setUnanchored(new Set(report.unanchored));
        } : undefined}
      />
    );
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<Host />);
  return {
    reports,
    set: (next: HostState) => set!(next),
    renders: () => renders,
    idle: async () => {
      await sleep(100);
      const before = renders;
      await sleep(300);
      return renders - before;
    },
  };
}

const nodeComment = (id: string, nodeId: string, label: string, blockId: string): Annotation => ({
  id,
  blockId,
  startOffset: 0,
  endOffset: 0,
  type: AnnotationType.COMMENT,
  text: `on ${label}`,
  originalText: label,
  createdA: 1,
  diagramAnchor: { v: 1, family: 'flowchart', kind: 'node', id: nodeId, label, sourceLine: null },
});

describe.if(hasDom)('restore reports read through a ref: a real change still reports, to the latest callback', () => {
  test('diagram block: a new (unresolvable) comment arriving later is reported unanchored, to the newest callback', async () => {
    const fenceId = parserModule!.parseMarkdownToBlocks(MARKDOWN).find((b) => b.type === 'code')!.id;
    const first = nodeComment('saved-1', 'D', 'Approve?', fenceId);
    const page = mount({ markdown: MARKDOWN, annotations: [first], gen: 1, withCallback: true });
    await until(() => page.reports.some((r) => r.attempted.includes('saved-1')), 'first report');
    expect(await page.idle()).toBeLessThan(5);
    const settledCount = page.reports.length;
    expect(settledCount).toBeLessThanOrEqual(3);

    // Late annotations (SSE / another window) AND a new host callback in the same render.
    const late = nodeComment('late-1', 'ZZ', 'Nowhere', fenceId);
    page.set({ markdown: MARKDOWN, annotations: [first, late], gen: 2, withCallback: true });
    await until(() => page.reports.some((r) => r.unanchored.includes('late-1')), 'report naming the late unanchored comment');
    const latest = page.reports.filter((r) => r.attempted.includes('late-1'));
    expect(latest.every((r) => r.gen === 2)).toBe(true);
    expect(latest.at(-1)!.unanchored).toEqual(['late-1']);
    expect(latest.at(-1)!.attempted.sort()).toEqual(['late-1', 'saved-1']);
    expect(await page.idle()).toBeLessThan(5);
  });

  test('diagram block: a callback that appears later (undefined -> defined) gets the report', async () => {
    const fenceId = parserModule!.parseMarkdownToBlocks(MARKDOWN).find((b) => b.type === 'code')!.id;
    const first = nodeComment('saved-1', 'D', 'Approve?', fenceId);
    const page = mount({ markdown: MARKDOWN, annotations: [first], gen: 1, withCallback: false });
    await until(() => host!.querySelector('[data-diagram-badge="saved-1"]') !== null, 'badge');
    expect(page.reports.length).toBe(0);
    page.set({ markdown: MARKDOWN, annotations: [first], gen: 7, withCallback: true });
    await until(() => page.reports.some((r) => r.attempted.includes('saved-1')), 'report after the callback appears');
    expect(page.reports.every((r) => r.gen === 7)).toBe(true);
    expect(await page.idle()).toBeLessThan(5);
  });

  test('viewer no-diagram report: a new diagram comment arriving later is reported, to the newest callback', async () => {
    const markdown = ['# Harbor rollout', '', 'No diagram here.', ''].join('\n');
    const a = nodeComment('orphan-1', 'D', 'Approve?', 'gone');
    const page = mount({ markdown, annotations: [a], gen: 1, withCallback: true });
    await until(() => page.reports.some((r) => r.unanchored.includes('orphan-1')), 'first orphan report');
    expect(await page.idle()).toBeLessThan(5);
    const b = nodeComment('orphan-2', 'M', 'Merge', 'gone');
    page.set({ markdown, annotations: [a, b], gen: 3, withCallback: true });
    await until(() => page.reports.some((r) => r.unanchored.includes('orphan-2')), 'second orphan report');
    expect(page.reports.filter((r) => r.unanchored.includes('orphan-2')).every((r) => r.gen === 3)).toBe(true);
    expect(await page.idle()).toBeLessThan(5);
  });

  test('viewer image-region report: the image leaving the document re-reports it unanchored, to the newest callback', async () => {
    const withImage = ['# Status colors', '', '![Job status colors](figures/status-colors.png)', '', 'Rollout next.', ''].join('\n');
    const without = ['# Status colors', '', 'The figure was removed.', '', 'Rollout next.', ''].join('\n');
    const region: Annotation = {
      id: 'region-1', blockId: '', startOffset: 0, endOffset: 0, type: AnnotationType.COMMENT,
      text: 'too pale', originalText: '', createdA: 1,
      imageRegion: { v: 1, src: 'figures/status-colors.png', sourceLine: 3, box: { x: 10, y: 10, w: 50, h: 50 }, naturalWidth: 2000, naturalHeight: 1000 },
    };
    const page = mount({ markdown: withImage, annotations: [region], gen: 1, withCallback: true });
    await until(() => page.reports.some((r) => r.attempted.includes('region-1')), 'found report');
    expect(page.reports.every((r) => r.unanchored.length === 0)).toBe(true);
    expect(await page.idle()).toBeLessThan(5);
    page.set({ markdown: without, annotations: [region], gen: 4, withCallback: true });
    await until(() => page.reports.some((r) => r.unanchored.includes('region-1')), 'unanchored report');
    expect(page.reports.filter((r) => r.unanchored.includes('region-1')).every((r) => r.gen === 4)).toBe(true);
    expect(await page.idle()).toBeLessThan(5);
  });
});
