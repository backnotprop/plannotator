/**
 * Lazy diagram runtimes must be strictly no worse than a static import on a
 * chunking host: a transient failure of the Mermaid or Graphviz chunk must
 * not leave the diagram dead.
 *
 * What regresses if these fail:
 * - a rejected import() stays memoized, so every later attempt replays the
 *   cached rejection and the diagram can never render in that page;
 * - the automatic single re-attempt is gone, so a one-off fetch hiccup lands
 *   the user on the error panel;
 * - a persistent failure no longer shows the existing error panel with the
 *   source (never blank), or its Retry no longer issues a fresh attempt.
 *
 * The runtimes are stood in for through the test hooks so the real Mermaid
 * and Graphviz never load; the rendered SVG is a sentinel string.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Block } from '../types';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { MermaidBlock, __setMermaidRuntimeLoaderForTests } from './MermaidBlock';
import { GraphvizBlock, __setVizLoaderForTests } from './GraphvizBlock';

// happy-dom cannot host DOMPurify: the render slot's parse step is the inert
// template parse for these tests (the scrub still runs).
let restoreParser: (() => void) | null = null;
beforeAll(() => {
  if (hasDom) restoreParser = installInertDiagramSvgParser();
});
afterAll(() => restoreParser?.());
import {
  getMathRenderer,
  getMathRendererSource,
  resetMathRenderer,
  setMathRenderer,
  setMathRendererLoader,
  type MathRenderer,
} from '../utils/math';

const hasDom = typeof document !== 'undefined';
const RETRY_DELAY_MS = 10;
const SVG = '<svg viewBox="0 0 10 10" data-sentinel="diagram"><rect width="10" height="10"/></svg>';

const mermaidBlock: Block = { id: 'm1', type: 'code', language: 'mermaid', content: 'flowchart LR\n  A --> B', order: 0, startLine: 1 };
const dotBlock: Block = { id: 'g1', type: 'code', language: 'dot', content: 'digraph { A -> B }', order: 0, startLine: 1 };

const fakeMermaid = { initialize() {}, render: async () => ({ svg: SVG }) } as never;
// The renderer slot drives the engine through `render()` (a value with the
// status and the errors, never a throw for a bad graph), so the stand-in
// answers that shape.
const fakeViz = { render: () => ({ status: 'success', output: SVG, errors: [] }) } as never;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  __setMermaidRuntimeLoaderForTests(undefined);
  __setVizLoaderForTests(undefined);
});

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
  return host;
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** A loader that rejects `failures` times, then resolves `value`. */
function flakyLoader<T>(value: T, failures: number): { load: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    load: () => {
      calls += 1;
      return calls <= failures ? Promise.reject(new Error(`chunk failed (${calls})`)) : Promise.resolve(value);
    },
    calls: () => calls,
  };
}

const cases = [
  {
    name: 'Mermaid',
    install: (loader: () => Promise<unknown>) => __setMermaidRuntimeLoaderForTests(loader as never, { retryDelayMs: RETRY_DELAY_MS }),
    runtime: fakeMermaid,
    element: <MermaidBlock block={mermaidBlock} />,
    source: mermaidBlock.content,
    errorTitle: 'Mermaid Error',
  },
  {
    name: 'Graphviz',
    install: (loader: () => Promise<unknown>) => __setVizLoaderForTests(loader as never, { retryDelayMs: RETRY_DELAY_MS }),
    runtime: fakeViz,
    element: <GraphvizBlock block={dotBlock} />,
    source: dotBlock.content,
    errorTitle: 'Graphviz Error',
  },
];

/**
 * Since Mermaid 12 the plan editor takes the lazy path itself, so the window
 * between mount and the first render is now a user-visible state on every
 * surface. What regresses: the block flashes the error panel (or nothing)
 * while the runtime is still loading, instead of the source under a status.
 */
describe('Mermaid pending state', () => {
  test.skipIf(!hasDom)('shows the source under a rendering status until the runtime lands, never the error panel', async () => {
    let release: (() => void) | null = null;
    __setMermaidRuntimeLoaderForTests(
      () => new Promise((resolve) => { release = () => resolve(fakeMermaid); }),
      { retryDelayMs: RETRY_DELAY_MS },
    );
    const el = await mount(<MermaidBlock block={mermaidBlock} />);
    await settle(RETRY_DELAY_MS);

    expect(el.querySelector('[data-mermaid-pending]')).not.toBeNull();
    expect(el.textContent).toContain('Rendering diagram');
    expect(el.textContent).toContain(mermaidBlock.content);
    expect(el.textContent).not.toContain('Mermaid Error');
    expect(el.innerHTML).not.toContain('data-sentinel="diagram"');

    await act(async () => { release!(); });
    await settle(RETRY_DELAY_MS * 3);

    expect(el.querySelector('[data-mermaid-pending]')).toBeNull();
    expect(el.textContent).not.toContain('Rendering diagram');
    expect(el.innerHTML).toContain('data-sentinel="diagram"');
  });
});

describe.each(cases)('$name lazy runtime', ({ install, runtime, element, source, errorTitle }) => {
  test.skipIf(!hasDom)('a runtime that fails once renders the diagram after the automatic re-attempt', async () => {
    const loader = flakyLoader(runtime, 1);
    install(loader.load);
    const el = await mount(element);
    await settle(RETRY_DELAY_MS * 5);

    expect(loader.calls()).toBe(2);
    expect(el.innerHTML).toContain('data-sentinel="diagram"');
    expect(el.textContent).not.toContain(errorTitle);
  });

  test.skipIf(!hasDom)('a persistently failing runtime shows the error panel with the source, and Retry issues a fresh attempt', async () => {
    let healthy = false;
    let calls = 0;
    install(() => {
      calls += 1;
      return healthy ? Promise.resolve(runtime) : Promise.reject(new Error('chunk failed'));
    });
    const el = await mount(element);
    await settle(RETRY_DELAY_MS * 5);

    // Two attempts (initial + automatic re-attempt), then the existing panel.
    expect(calls).toBe(2);
    expect(el.textContent).toContain(errorTitle);
    expect(el.textContent).toContain('chunk failed');
    expect(el.textContent).toContain(source);
    expect(el.innerHTML).not.toContain('data-sentinel="diagram"');

    const retry = el.querySelector<HTMLButtonElement>('button[title="Retry loading the diagram renderer"]');
    expect(retry).not.toBeNull();

    healthy = true;
    await act(async () => {
      retry!.click();
    });
    await settle(RETRY_DELAY_MS * 5);

    expect(calls).toBe(3);
    expect(el.innerHTML).toContain('data-sentinel="diagram"');
    expect(el.textContent).not.toContain(errorTitle);
  });

  test.skipIf(!hasDom)('one Retry re-attempts every sibling block that failed on the shared runtime', async () => {
    // The runtime is memoized per module, so all blocks fail together; a
    // Retry that bumped only its own block left the siblings on stale error
    // panels after the runtime had recovered.
    let healthy = false;
    let calls = 0;
    install(() => {
      calls += 1;
      return healthy ? Promise.resolve(runtime) : Promise.reject(new Error('down'));
    });
    const el = await mount(
      <>
        <div id="a">{element}</div>
        <div id="b">{element}</div>
      </>,
    );
    await settle(RETRY_DELAY_MS * 5);
    const a = el.querySelector('#a')!;
    const b = el.querySelector('#b')!;
    expect(a.textContent).toContain(errorTitle);
    expect(b.textContent).toContain(errorTitle);

    healthy = true;
    const callsBeforeRetry = calls;
    const retry = a.querySelector<HTMLButtonElement>('button[title="Retry loading the diagram renderer"]');
    await act(async () => {
      retry!.click();
    });
    await settle(RETRY_DELAY_MS * 5);

    expect(a.innerHTML).toContain('data-sentinel="diagram"');
    expect(b.innerHTML).toContain('data-sentinel="diagram"');
    expect(b.textContent).not.toContain(errorTitle);
    // Both blocks re-attempt in the same commit and share one memoized load.
    expect(calls).toBe(callsBeforeRetry + 1);
  });

  test.skipIf(!hasDom)('a diagram syntax error keeps the existing panel without a Retry button', async () => {
    const broken = { initialize() {}, render: () => { throw new Error('Parse error'); } } as never;
    let calls = 0;
    install(() => { calls += 1; return Promise.resolve(broken); });
    const el = await mount(element);
    await settle(RETRY_DELAY_MS * 5);

    expect(calls).toBe(1);
    expect(el.textContent).toContain(errorTitle);
    expect(el.textContent).toContain('Parse error');
    expect(el.textContent).toContain(source);
    expect(el.querySelector('button[title="Retry loading the diagram renderer"]')).toBeNull();
  });
});

/**
 * A host that redirects Mermaid's `katex` import to `utils/mermaid-math-slot`
 * gets `$$` labels typeset through the math slot, which is only useful if the
 * slot is filled by the time Mermaid renders. What regresses: the block stops
 * awaiting the registered loader before a math diagram (labels throw on an
 * empty slot), or starts loading KaTeX for diagrams with no math at all.
 */
describe('Mermaid math labels warm the math slot', () => {
  const savedRenderer = getMathRenderer();
  const savedSource = getMathRendererSource();
  const hostRenderer: MathRenderer = { renderToString: (tex) => tex };

  afterEach(() => {
    resetMathRenderer();
    setMathRendererLoader(null);
    if (savedRenderer) setMathRenderer(savedRenderer, savedSource ?? 'host');
  });

  test.skipIf(!hasDom)('a diagram with a $$ label awaits the registered loader before rendering', async () => {
    resetMathRenderer();
    let loads = 0;
    setMathRendererLoader(async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return hostRenderer;
    });
    let slotAtRender: MathRenderer | null | undefined;
    const runtime = {
      initialize() {},
      render: async () => {
        slotAtRender = getMathRenderer();
        return { svg: SVG };
      },
    } as never;
    __setMermaidRuntimeLoaderForTests(() => Promise.resolve(runtime), { retryDelayMs: RETRY_DELAY_MS });

    const mathBlock: Block = { ...mermaidBlock, id: 'm-math', content: 'flowchart LR\n  A["$$\\sqrt{2}$$"] --> B' };
    const el = await mount(<MermaidBlock block={mathBlock} />);
    await settle(RETRY_DELAY_MS * 5);

    expect(loads).toBe(1);
    expect(slotAtRender).toBe(hostRenderer);
    expect(el.innerHTML).toContain('data-sentinel="diagram"');
  });

  test.skipIf(!hasDom)('a diagram without math never invokes the math loader', async () => {
    resetMathRenderer();
    let loads = 0;
    setMathRendererLoader(async () => {
      loads += 1;
      return hostRenderer;
    });
    __setMermaidRuntimeLoaderForTests(() => Promise.resolve(fakeMermaid), { retryDelayMs: RETRY_DELAY_MS });

    const el = await mount(<MermaidBlock block={mermaidBlock} />);
    await settle(RETRY_DELAY_MS * 5);

    expect(loads).toBe(0);
    expect(getMathRenderer()).toBeNull();
    expect(el.innerHTML).toContain('data-sentinel="diagram"');
  });
});
