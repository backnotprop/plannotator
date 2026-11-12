import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import katex from 'katex';
import {
  getMathRenderer,
  getMathRendererLoader,
  getMathRendererSource,
  loadMathRenderer,
  renderMathToHtml,
  resetMathRenderer,
  setMathRenderer,
  setMathRendererLoader,
  subscribeMathRenderer,
  type MathRenderer,
} from './math';
import { MathBlock } from '../components/blocks/MathBlock';
import { InlineMarkdown } from '../components/InlineMarkdown';
import type { Block } from '../types';

const savedRenderer = getMathRenderer();
const savedSource = getMathRendererSource();

const displayBlock: Block = {
  id: 'math-1',
  type: 'math',
  content: '  E = mc^2  ',
  order: 0,
  startLine: 1,
};

beforeEach(() => {
  resetMathRenderer();
  setMathRendererLoader(null);
});

afterEach(() => {
  resetMathRenderer();
  setMathRendererLoader(null);
  if (savedRenderer) setMathRenderer(savedRenderer, savedSource ?? 'host');
});

describe('empty slot', () => {
  test('MathBlock renders the wrapper with the TeX as text and the full anchor attribute set', () => {
    const html = renderToStaticMarkup(createElement(MathBlock, { block: displayBlock }));
    expect(html).not.toContain('katex');
    expect(html).toContain('class="math-block math-annotatable');
    expect(html).toContain('data-block-id="math-1"');
    expect(html).toContain('data-block-type="math"');
    expect(html).toContain('data-math-tex="E = mc^2"');
    expect(html).toContain('data-math-display="true"');
    expect(html).toContain('aria-label="E = mc^2"');
    expect(html).toContain('>E = mc^2</div>');
  });

  test('inline math renders the wrapper with the TeX as text and the same attributes', () => {
    const html = renderToStaticMarkup(createElement(InlineMarkdown, { text: 'Area is $A=\\pi r^2$.' }));
    expect(html).not.toContain('katex');
    expect(html).toContain('class="math-inline math-annotatable');
    expect(html).toContain('data-math-tex="A=\\pi r^2"');
    expect(html).toContain('data-math-display="false"');
    expect(html).toContain('>A=\\pi r^2</span>');
  });

  test('placeholder TeX is a text child, never markup', () => {
    const hostile: Block = { ...displayBlock, content: '<img src=x onerror=alert(1)>' };
    const html = renderToStaticMarkup(createElement(MathBlock, { block: hostile }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('filled slot', () => {
  test('renders KaTeX markup in the same synchronous render, no effect needed', () => {
    setMathRenderer(katex);
    const html = renderToStaticMarkup(createElement(MathBlock, { block: displayBlock }));
    expect(html).toContain('katex-display');
    expect(html).toContain('data-math-tex="E = mc^2"');
    expect(html).not.toContain('>E = mc^2</div>');
  });

  test('registering notifies subscribers exactly once per change', () => {
    let calls = 0;
    const unsubscribe = subscribeMathRenderer(() => {
      calls += 1;
    });
    setMathRenderer(katex);
    setMathRenderer(katex); // same renderer: no notification
    expect(calls).toBe(1);
    unsubscribe();
    resetMathRenderer();
    expect(calls).toBe(1);
  });
});

describe('loadMathRenderer', () => {
  test('resolves at once from a filled slot without calling the loader', async () => {
    let loads = 0;
    setMathRendererLoader(async () => {
      loads += 1;
      return katex;
    });
    setMathRenderer(katex);
    expect(await loadMathRenderer()).toBe(katex);
    expect(loads).toBe(0);
  });

  test('is idempotent: concurrent calls share one load, later calls reuse the result', async () => {
    let loads = 0;
    setMathRendererLoader(async () => {
      loads += 1;
      return katex;
    });
    const [a, b] = await Promise.all([loadMathRenderer(), loadMathRenderer()]);
    expect(a).toBe(katex);
    expect(b).toBe(katex);
    expect(getMathRenderer()).toBe(katex);
    expect(getMathRendererSource()).toBe('loader');
    await loadMathRenderer();
    expect(loads).toBe(1);
  });

  test('a rejected load is dropped so the next call retries', async () => {
    let attempts = 0;
    setMathRendererLoader(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('chunk failed');
      return katex;
    });
    await expect(loadMathRenderer()).rejects.toThrow('chunk failed');
    expect(getMathRenderer()).toBeNull();
    expect(await loadMathRenderer()).toBe(katex);
    expect(attempts).toBe(2);
  });

  test('with no loader registered, the default path loads KaTeX', async () => {
    expect(await loadMathRenderer()).toBe(katex);
    expect(getMathRendererSource()).toBe('loader');
  });

  test('a registered loader is never backfilled by the default, even after it rejects', async () => {
    // The slot must stay empty.
    setMathRendererLoader(async () => {
      throw new Error('host chunk failed');
    });
    await expect(loadMathRenderer()).rejects.toThrow('host chunk failed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getMathRenderer()).toBeNull();
    expect(getMathRendererSource()).toBeNull();
  });

  test('honors the host loader seam and registers what it returns', async () => {
    const hostRenderer: MathRenderer = {
      renderToString: (tex) => `<span class="host-math">${tex}</span>`,
    };
    setMathRendererLoader(async () => hostRenderer);
    await loadMathRenderer();
    expect(getMathRenderer()).toBe(hostRenderer);
    const html = renderToStaticMarkup(createElement(MathBlock, { block: displayBlock }));
    expect(html).toContain('<span class="host-math">E = mc^2</span>');
  });
});

describe('resetMathRenderer', () => {
  // Reset means the renderer and its source, never the seam a host configured once at startup.
  test('keeps the registered loader: the next load uses it, never the default', async () => {
    const hostRenderer: MathRenderer = {
      renderToString: (tex) => `<span class="host-math">${tex}</span>`,
    };
    let loads = 0;
    const hostLoader = async () => {
      loads += 1;
      return hostRenderer;
    };
    setMathRendererLoader(hostLoader);
    setMathRenderer(katex);
    resetMathRenderer();

    expect(getMathRenderer()).toBeNull();
    expect(getMathRendererSource()).toBeNull();
    expect(getMathRendererLoader()).toBe(hostLoader);
    expect(await loadMathRenderer()).toBe(hostRenderer);
    expect(getMathRendererSource()).toBe('loader');
    expect(loads).toBe(1);
  });

  test('forgets a load in flight: its late result never fills the slot, and the next load invokes the loader afresh', async () => {
    let release: (renderer: MathRenderer) => void = () => {};
    let loads = 0;
    const hostRenderer: MathRenderer = { renderToString: (tex) => tex };
    setMathRendererLoader(() => {
      loads += 1;
      return new Promise<MathRenderer>((resolve) => {
        release = resolve;
      });
    });
    const stale = loadMathRenderer();
    resetMathRenderer();
    release(hostRenderer);
    expect(await stale).toBe(hostRenderer); // the caller that awaited it still gets its value
    expect(getMathRenderer()).toBeNull(); // but the reset slot stays empty

    const fresh = loadMathRenderer();
    expect(loads).toBe(2);
    release(hostRenderer);
    expect(await fresh).toBe(hostRenderer);
    expect(getMathRenderer()).toBe(hostRenderer);
  });

  test('setMathRendererLoader(null) is the explicit way back to the package default', async () => {
    setMathRendererLoader(async () => ({ renderToString: (tex) => tex }));
    setMathRendererLoader(null);
    expect(getMathRendererLoader()).toBeNull();
    expect(await loadMathRenderer()).toBe(katex);
  });
});

describe('renderMathToHtml', () => {
  test('returns null while no renderer is registered', () => {
    expect(renderMathToHtml('x', false)).toBeNull();
  });

  // Deliberate security pin: `trust: false` and `throwOnError: false` are applied to EVERY
  // renderer, including one a host registered, so document TeX can never widen what the renderer
  // may emit.
  test('pins trust:false and throwOnError:false regardless of the registered renderer', () => {
    const seen: unknown[] = [];
    const spy: MathRenderer = {
      renderToString: (_tex, options) => {
        seen.push(options);
        return '';
      },
    };
    setMathRenderer(spy);
    renderMathToHtml('x', true);
    renderMathToHtml('y', false, spy);
    expect(seen).toHaveLength(2);
    for (const options of seen) {
      expect(options).toMatchObject({ trust: false, throwOnError: false, output: 'html' });
    }
    expect(seen[0]).toMatchObject({ displayMode: true });
    expect(seen[1]).toMatchObject({ displayMode: false });
  });
});
