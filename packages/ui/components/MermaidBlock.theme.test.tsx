/**
 * MermaidBlock follows the active colour theme and mode.
 *
 * What regresses if these fail:
 * - the block renders without first initializing the runtime for the palette
 *   on screen, so a diagram comes up in the static slate palette;
 * - a palette or mode change no longer re-renders an already rendered
 *   diagram (the code-fence re-highlight pattern), so a user who flips to
 *   light mode keeps a dark diagram until reload;
 * - the `(palette, mode)` cache stops holding, so every block on a page
 *   re-runs the global `initialize` (or two blocks under one theme run it
 *   twice);
 * - the host fallback breaks: with no theme tokens on the document the block
 *   must not call `initialize` at all.
 *
 * The runtime is a stand-in (no real Mermaid); the tokens are injected as a
 * stylesheet under the same `theme-*` / `light` classes ThemeProvider sets.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Block } from '../types';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { MermaidBlock, __setMermaidRuntimeLoaderForTests } from './MermaidBlock';
import { ThemeProvider, useTheme } from './ThemeProvider';
import { __resetMermaidThemeForTests } from '../utils/mermaidTheme';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';

const hasDom = typeof document !== 'undefined';

// happy-dom cannot host DOMPurify: the render slot's parse step is the inert
// template parse for these tests (the scrub still runs).
let restoreParser: (() => void) | null = null;
beforeAll(() => {
  if (hasDom) restoreParser = installInertDiagramSvgParser();
});
afterAll(() => restoreParser?.());

const block: Block = { id: 'themeSweep', type: 'code', language: 'mermaid', content: 'flowchart LR\n  A --> B', order: 0, startLine: 1 };
const SVG = '<svg viewBox="0 0 10 10" data-sentinel="diagram"><rect width="10" height="10"/></svg>';

/** `github` is a shipped palette id, so ThemeProvider accepts it; the tokens are ours. */
const TOKENS_CSS = `
.theme-github { --background: #24292e; --foreground: #e1e4e8; --card: #1f2428; --card-foreground: #e1e4e8; --border: #1b1f23; --muted: #2f363d; --muted-foreground: #6a737d; --primary: #58a6ff; }
.theme-github.light { --background: #ffffff; --foreground: #24292e; --card: #f6f8fa; --card-foreground: #24292e; --border: #e1e4e8; --muted: #f6f8fa; --muted-foreground: #6a737d; --primary: #0366d6; }
`;

interface Recorded {
  initialize: unknown[];
  renders: number;
}

function fakeRuntime(): { runtime: any; recorded: Recorded } {
  const recorded: Recorded = { initialize: [], renders: 0 };
  const runtime = {
    initialize(config: unknown) {
      recorded.initialize.push(config);
    },
    async render() {
      recorded.renders += 1;
      return { svg: SVG };
    },
  };
  return { runtime, recorded };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let styleEl: HTMLStyleElement | null = null;
const stored = new Map<string, string>();
let setModeFromTest: ((mode: 'dark' | 'light') => void) | null = null;

function ModeHandle(): null {
  const { setMode } = useTheme();
  setModeFromTest = setMode;
  return null;
}

async function mount(children: React.ReactNode, withProvider = true): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      withProvider ? (
        <ThemeProvider defaultTheme="dark" defaultColorTheme="github">
          <ModeHandle />
          {children}
        </ThemeProvider>
      ) : (
        <>{children}</>
      ),
    );
  });
}

async function settle(): Promise<void> {
  // The render effect awaits the (already resolved) runtime, then the render.
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

function svgCount(): number {
  return host?.querySelectorAll('svg[data-sentinel="diagram"]').length ?? 0;
}

describe('MermaidBlock theming', () => {
  beforeEach(() => {
    if (!hasDom) return;
    stored.clear();
    setStorageBackend({
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => {
        stored.set(key, value);
      },
      removeItem: (key) => {
        stored.delete(key);
      },
    });
    __resetMermaidThemeForTests();
    styleEl = document.createElement('style');
    styleEl.textContent = TOKENS_CSS;
    document.head.appendChild(styleEl);
  });

  afterEach(async () => {
    if (!hasDom) return;
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    root = null;
    host?.remove();
    host = null;
    styleEl?.remove();
    styleEl = null;
    setModeFromTest = null;
    for (const cls of Array.from(document.documentElement.classList)) {
      if (cls.startsWith('theme-') || cls === 'light') document.documentElement.classList.remove(cls);
    }
    __setMermaidRuntimeLoaderForTests(undefined);
    __resetMermaidThemeForTests();
    resetStorageBackend();
  });

  test.skipIf(!hasDom)('initializes for the palette on screen before rendering, and re-renders on a mode change without a second initialize per block', async () => {
    const { runtime, recorded } = fakeRuntime();
    __setMermaidRuntimeLoaderForTests(async () => runtime, { retryDelayMs: 5 });

    await mount(
      <>
        <MermaidBlock block={block} />
        <MermaidBlock block={{ ...block, id: 'themeSweepTwo' }} />
      </>,
    );
    await settle();

    expect(svgCount()).toBe(2);
    expect(recorded.renders).toBe(2);
    // One initialize for two blocks under one (palette, mode).
    expect(recorded.initialize).toHaveLength(1);
    const dark = recorded.initialize[0] as { theme: string; themeVariables: Record<string, string>; securityLevel: string };
    expect(dark.theme).toBe('dark');
    expect(dark.securityLevel).toBe('strict');
    expect(dark.themeVariables.nodeBkg).toBe('#1f2428');

    await act(async () => {
      setModeFromTest!('light');
    });
    await settle();

    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(recorded.initialize).toHaveLength(2);
    const light = recorded.initialize[1] as { theme: string; themeVariables: Record<string, string> };
    expect(light.theme).toBe('default');
    expect(light.themeVariables.nodeBkg).toBe('#f6f8fa');
    // Both diagrams were re-rendered under the new theme.
    expect(recorded.renders).toBe(4);
    expect(svgCount()).toBe(2);
  });

  test.skipIf(!hasDom)('without theme tokens on the document the runtime is never re-initialized (host fallback)', async () => {
    styleEl?.remove();
    styleEl = null;
    const { runtime, recorded } = fakeRuntime();
    __setMermaidRuntimeLoaderForTests(async () => runtime, { retryDelayMs: 5 });

    await mount(<MermaidBlock block={block} />, false);
    await settle();

    expect(svgCount()).toBe(1);
    expect(recorded.renders).toBe(1);
    expect(recorded.initialize).toEqual([]);
  });
});
