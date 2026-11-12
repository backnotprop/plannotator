/**
 * Both facts are asserted: the committed HTML and an empty MutationObserver log after the
 * microtask queue drained.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import katex from 'katex';

import '../utils/math-eager';
import { getMathRenderer, getMathRendererSource, resetMathRenderer, setMathRenderer } from '../utils/math';
import { MathBlock } from './blocks/MathBlock';
import type { Block } from '../types';

const hasDom = typeof document !== 'undefined';
const savedRenderer = getMathRenderer();
const savedSource = getMathRendererSource();

const block: Block = { id: 'math-1', type: 'math', content: '\\int_0^1 x^2 dx', order: 0, startLine: 1 };

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  resetMathRenderer();
  if (savedRenderer) setMathRenderer(savedRenderer, savedSource ?? 'host');
});

function mount(): { html: string; mutations: MutationRecord[] } {
  host = document.createElement('div');
  document.body.appendChild(host);
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver((records) => mutations.push(...records));
  observer.observe(host, { childList: true, subtree: true, characterData: true, attributes: true });
  root = createRoot(host);
  act(() => {
    root!.render(<MathBlock block={block} />);
  });
  const html = host.innerHTML;
  return { html, mutations };
}

describe('MathBlock first paint', () => {
  test.skipIf(!hasDom)('with the eager entry imported, the first commit is typeset KaTeX and nothing swaps afterwards', async () => {
    expect(getMathRenderer()).toBe(katex);
    const { html, mutations } = mount();

    expect(html).toContain('katex-display');
    expect(html).not.toContain('>\\int_0^1 x^2 dx</div>');
    expect(host!.querySelector('[data-math-tex]')?.getAttribute('data-math-tex')).toBe('\\int_0^1 x^2 dx');

    // Let effects, microtasks and any pending re-render settle, then compare.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const mountRecords = mutations.filter((m) => m.target === host && m.type === 'childList');
    const laterRecords = mutations.filter((m) => !(m.target === host && m.type === 'childList'));
    expect(mountRecords.length).toBeGreaterThanOrEqual(1);
    expect(laterRecords).toHaveLength(0);
    expect(host!.innerHTML).toBe(html);
  });

  test.skipIf(!hasDom)('without registration the placeholder commits first and typesets once the renderer lands', async () => {
    resetMathRenderer();
    const { html } = mount();

    expect(html).not.toContain('katex');
    expect(html).toContain('>\\int_0^1 x^2 dx</div>');
    expect(host!.querySelector('[data-math-tex]')?.getAttribute('data-block-id')).toBe('math-1');

    await act(async () => {
      setMathRenderer(katex);
    });
    expect(host!.innerHTML).toContain('katex-display');
    expect(host!.innerHTML).not.toContain('>\\int_0^1 x^2 dx</div>');
  });
});
