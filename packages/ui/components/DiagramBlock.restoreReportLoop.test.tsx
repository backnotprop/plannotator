/**
 * A diagram comment restored from storage, in a host whose `onRestoreReport`
 * is a fresh function each render that stores the report as new state (the
 * Inbox's file pane does exactly this). Driven through the REAL Viewer.
 *
 * What regresses if this fails: the diagram block re-sends its restore report
 * every time the host's callback changes, the host's state changes, the host
 * renders a new callback, and so on, thousands of renders a second while the
 * page sits still. A click on the commented part then turns that churn into a
 * synchronous loop (React error #185, "Maximum update depth exceeded"): the
 * block falls back to its source under "Couldn't load this view. Reload" and
 * the comment's part can no longer be clicked.
 *
 * The Viewer's own two restore reports (a comment on part of an image, a
 * diagram comment in a document with no diagram) had the same loop in the
 * same host, without the click: the page re-rendered without end, unseen.
 *
 * React's act() never settles while such a loop runs, so this file renders
 * outside act() with real timers and bounded waits: it fails, not hangs.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AnnotationRestoreReport } from '../hooks/useAnnotationHighlighter';
import { AnnotationType, type Annotation } from '../types';
import { drawMermaidFencesWithMermaid } from '../test-setup/mermaidEngine';

// A stand-in Mermaid runtime draws here; Pele is DiagramBlock.engine.test.tsx's.
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
const consoleErrors: string[] = [];
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
  // Outside act(): React would otherwise warn on every update, and a loop must be seen, not waited on.
  actFlag.IS_REACT_ACT_ENVIRONMENT = false;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  };
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
  consoleErrors.length = 0;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (read()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The REAL Viewer under a host shaped like the Inbox's file pane: its
 * `onRestoreReport` is a new function every render, and it stores the report
 * as new state (a new Set), so every report re-renders the host.
 */
function mountInboxShapedHost(markdown: string, annotations: Annotation[]) {
  const blocks = parserModule!.parseMarkdownToBlocks(markdown);
  const reports: AnnotationRestoreReport[] = [];
  let renders = 0;
  const Viewer = viewerModule!.Viewer;
  function Host() {
    const [, setUnanchored] = useState<ReadonlySet<string>>(new Set());
    renders += 1;
    return (
      <Viewer
        blocks={blocks}
        markdown={markdown}
        annotations={annotations}
        onAddAnnotation={noop}
        onSelectAnnotation={noop}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        onRestoreReport={(report) => {
          reports.push(report);
          setUnanchored(new Set(report.unanchored));
        }}
      />
    );
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<Host />);
  return {
    reports,
    /** How many times the host rendered in 300 ms with nobody touching the page. */
    rendersWhileIdle: async (): Promise<number> => {
      await sleep(100);
      const before = renders;
      await sleep(300);
      return renders - before;
    },
  };
}

describe.if(hasDom)('Viewer: restore reports that are not the highlighter\'s, in the same host', () => {
  test('a comment on part of an image: reported once found, and the page settles', async () => {
    const markdown = ['# Status colors', '', '![Job status colors](figures/status-colors.png)', '', 'Rollout next.', ''].join('\n');
    const region: Annotation = {
      id: 'region-1',
      blockId: '',
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.COMMENT,
      text: 'Charlie Dunn: this swatch is too pale.',
      originalText: '',
      createdA: 1,
      imageRegion: { v: 1, src: 'figures/status-colors.png', sourceLine: 3, box: { x: 10, y: 10, w: 50, h: 50 }, naturalWidth: 2000, naturalHeight: 1000 },
    };
    const page = mountInboxShapedHost(markdown, [region]);
    await until(() => page.reports.some((report) => report.attempted.includes('region-1')), 'the image-region report');
    expect(page.reports.every((report) => !report.unanchored.includes('region-1'))).toBe(true);
    expect(await page.rendersWhileIdle()).toBeLessThan(5);
  });

  test('a diagram comment in a document with no diagram: reported unanchored, and the page settles', async () => {
    const markdown = ['# Harbor rollout', '', 'The diagram was removed from this page.', ''].join('\n');
    const orphan: Annotation = {
      id: 'orphan-1',
      blockId: 'gone-fence',
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.COMMENT,
      text: 'Bob Tully: who approves?',
      originalText: 'Approve?',
      createdA: 1,
      diagramAnchor: { v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: null },
    };
    const page = mountInboxShapedHost(markdown, [orphan]);
    await until(() => page.reports.some((report) => report.unanchored.includes('orphan-1')), 'the unanchored report');
    expect(await page.rendersWhileIdle()).toBeLessThan(5);
  });
});

describe.if(hasDom)('DiagramBlock: a restored node comment in a host that re-creates its restore callback', () => {
  test('the page settles, and a click on the commented node opens its composer with the diagram and its comment still drawn', async () => {
    const blocks = parserModule!.parseMarkdownToBlocks(MARKDOWN);
    const fence = blocks.find((block) => block.type === 'code')!;
    // Restored from storage after a reload: a comment Bob Tully left on node D.
    const annotations: Annotation[] = [
      {
        id: 'saved-1',
        blockId: fence.id,
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.COMMENT,
        text: 'Bob Tully: who approves?',
        originalText: 'Approve?',
        createdA: 1,
        diagramAnchor: { v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [5, 5] },
      },
    ];
    const page = mountInboxShapedHost(MARKDOWN, annotations);
    await until(() => host!.querySelector('[data-diagram-badge="saved-1"]') !== null, 'the restored comment on node D');
    // The block still says how the restore went: the comment was tried and found.
    await until(() => page.reports.some((report) => report.attempted.includes('saved-1')), 'the restore report');
    expect(page.reports.every((report) => !report.unanchored.includes('saved-1'))).toBe(true);

    // Left alone, the page stops rendering.
    expect(await page.rendersWhileIdle()).toBeLessThan(5);

    const node = host!.querySelector('[id$="-flowchart-D-1"]')!;
    const press = (type: string) =>
      node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, pointerId: 1 } as PointerEventInit));
    press('pointerdown');
    press('pointerup');
    await until(() => host!.querySelector('[data-diagram-composer]') !== null, 'the composer on node D');
    await sleep(200);

    expect(host!.querySelector('[data-diagram-composer]')!.textContent).toContain('Approve?');
    expect(host!.textContent).not.toContain("Couldn't load this view");
    expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull();
    expect(host!.querySelector('[data-diagram-badge="saved-1"]')).not.toBeNull();
    expect(consoleErrors.filter((line) => /Maximum update depth/.test(line))).toEqual([]);
  });
});
