import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import katex from 'katex';
import mermaidKatex, { MERMAID_MATH_SLOT_EMPTY_MESSAGE, hasMermaidMath } from './mermaid-math-slot';
import {
  getMathRenderer,
  getMathRendererSource,
  resetMathRenderer,
  setMathRenderer,
  setMathRendererLoader,
  type MathRenderer,
} from './math';

const savedRenderer = getMathRenderer();
const savedSource = getMathRendererSource();

beforeEach(() => {
  resetMathRenderer();
  setMathRendererLoader(null);
});

afterEach(() => {
  resetMathRenderer();
  setMathRendererLoader(null);
  if (savedRenderer) setMathRenderer(savedRenderer, savedSource ?? 'host');
});

/** The exact call Mermaid makes in `renderKatexUnsanitized` (unchanged 11 -> 12). */
const MERMAID_OPTIONS = { throwOnError: true, displayMode: true, output: 'mathml' } as const;

describe('default export (what Mermaid receives for `katex`)', () => {
  test('delegates to the registered renderer with the options Mermaid passed', () => {
    const seen: unknown[] = [];
    const hostRenderer: MathRenderer = {
      renderToString: (tex, options) => {
        seen.push([tex, options]);
        return `<host>${tex}</host>`;
      },
    };
    setMathRenderer(hostRenderer);
    expect(mermaidKatex.renderToString('\\sqrt{2}', MERMAID_OPTIONS)).toBe('<host>\\sqrt{2}</host>');
    expect(seen).toEqual([['\\sqrt{2}', MERMAID_OPTIONS]]);
  });

  test('with KaTeX in the slot the markup is what Mermaid got from its direct import', () => {
    setMathRenderer(katex);
    expect(mermaidKatex.renderToString('x^2', MERMAID_OPTIONS)).toBe(katex.renderToString('x^2', MERMAID_OPTIONS));
  });

  test('an empty slot throws a message naming the cause instead of rendering nothing', () => {
    expect(() => mermaidKatex.renderToString('x', MERMAID_OPTIONS)).toThrow(MERMAID_MATH_SLOT_EMPTY_MESSAGE);
  });

  test('follows the slot: a later registration is picked up without re-importing', () => {
    const first: MathRenderer = { renderToString: () => 'first' };
    const second: MathRenderer = { renderToString: () => 'second' };
    setMathRenderer(first);
    expect(mermaidKatex.renderToString('x')).toBe('first');
    setMathRenderer(second);
    expect(mermaidKatex.renderToString('x')).toBe('second');
  });
});

describe('hasMermaidMath', () => {
  test('matches exactly the `$$...$$` labels Mermaid renders through KaTeX', () => {
    expect(hasMermaidMath('flowchart LR\n  A["$$\\sqrt{2}$$"] --> B')).toBe(true);
    expect(hasMermaidMath('A["$$$$"] --> B')).toBe(true);
    expect(hasMermaidMath('flowchart LR\n  A[Cost: $5] --> B[$10]')).toBe(false);
    expect(hasMermaidMath('flowchart LR\n  A --> B')).toBe(false);
  });
});
