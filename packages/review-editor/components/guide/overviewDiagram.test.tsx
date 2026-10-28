/**
 * A guide overview's Mermaid diagram in the review app: drawn by the diagram
 * engine the server serves on demand (the same loader as Markdown previews),
 * shown as its source while the engine loads, without an engine advert, and
 * with a note when it fails to load. An HTML picture is left to the guide
 * chain's own note.
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FIXTURE_V1_LOCAL, FIXTURE_V2_HTML, FIXTURE_V2_OVERVIEW } from '@plannotator/core/guide-format-fixtures';
import type { GuideSnapshot } from '@plannotator/core/guide-format';
import { GuideViewer } from '@plannotator/guide-viewer/GuideViewer';
import { loadDiagramEngine, __resetDiagramEngineForTests } from '../../utils/diagramEngine';
import type { DiagramEngineUrls } from '../../utils/diagramEngineContract';

const hasDom = typeof document !== 'undefined';
const { overviewDiagramRenderer } = hasDom ? await import('./overviewDiagram') : ({} as typeof import('./overviewDiagram'));

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  if (!hasDom || typeof globalThis.IntersectionObserver !== 'undefined') return;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  __resetDiagramEngineForTests();
  if (hasDom) document.body.innerHTML = '';
});

const FakeDiff = () => null;

async function mountGuide(snapshot: GuideSnapshot, urls: DiagramEngineUrls | null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <GuideViewer
        snapshot={snapshot}
        DiffRenderer={FakeDiff as never}
        getDiffRendererProps={() => ({})}
        renderOverviewDiagram={overviewDiagramRenderer(urls)}
      />,
    );
    await new Promise((r) => setTimeout(r, 40));
  });
  return host.querySelector('[data-guide-overview-diagram]');
}

const source = (FIXTURE_V2_OVERVIEW as { guide: { overview: { diagram: { source: string } } } }).guide.overview.diagram.source;

describe.if(hasDom)('the guide overview diagram in code review', () => {
  test('without an engine advert, the chain shows the Mermaid source', async () => {
    expect(overviewDiagramRenderer(null)).toBeUndefined();
    const box = await mountGuide(FIXTURE_V2_OVERVIEW, null);
    expect(box?.querySelector('pre')?.textContent).toBe(source);
    expect(box?.querySelector('[data-review-diagram]')).toBeNull();
  });

  test('with the engine, the diagram is drawn by it', async () => {
    const urls = { engine: '/assets/diagram-engine/engine-guide-ok.js', mermaid: '/m.js', graphviz: '/g.js' };
    await loadDiagramEngine(urls, async () => ({
      apiVersion: 1,
      DiagramFence: ({ kind, block }: { kind: string; block: { content: string } }) => <div data-stub-diagram={kind}>{block.content}</div>,
    }));
    const box = await mountGuide(FIXTURE_V2_OVERVIEW, urls);
    const drawn = box?.querySelector('[data-stub-diagram="mermaid"]');
    expect(drawn?.textContent).toBe(source);
    expect(box?.querySelector('pre')).toBeNull();
  });

  test('when the engine does not load, the source stays with a note', async () => {
    const box = await mountGuide(FIXTURE_V2_OVERVIEW, { engine: '/assets/diagram-engine/engine-guide-missing.js', mermaid: '/m.js', graphviz: '/g.js' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(box?.querySelector('pre')?.textContent).toBe(source);
    expect(box?.querySelector('[data-review-diagram="failed"] [data-review-diagram-note]')).not.toBeNull();
  });

  test('an HTML picture and a guide without an overview never load the engine', async () => {
    let imports = 0;
    const urls = { engine: '/assets/diagram-engine/engine-guide-html.js', mermaid: '/m.js', graphviz: '/g.js' };
    const render = overviewDiagramRenderer(urls)!;
    expect(render({ kind: 'html', source: '<svg/>' })).toBeNull();
    const box = await mountGuide(FIXTURE_V2_HTML, urls);
    expect(box?.textContent).toContain('does not draw');
    await mountGuide(FIXTURE_V1_LOCAL, urls);
    // Nothing asked for the engine: a later load is this test's first import.
    await loadDiagramEngine(urls, async () => {
      imports += 1;
      return { apiVersion: 1, DiagramFence: () => null };
    });
    expect(imports).toBe(1);
  });
});
