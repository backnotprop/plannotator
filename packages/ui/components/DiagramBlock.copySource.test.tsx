/**
 * Copy source on a diagram: one press copies the fence's text, from the drawn
 * diagram's hover buttons and from the source view, without switching views
 * first.
 *
 * What regresses if these fail:
 * - the drawn diagram has no Copy source button, so copying needs Show
 *   source, a select, and a copy;
 * - the source view loses it;
 * - the button copies something other than the fence's text.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { __setMermaidRuntimeLoaderForTests, setMermaidRuntime } from '../utils/mermaid';
import { parseMarkdownToBlocks } from '../utils/parser';
import { MermaidBlock } from './MermaidBlock';

const hasDom = typeof document !== 'undefined';
const SOURCE = 'flowchart LR\n  A[Start] --> B[End]';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40"/></svg>';

let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreParser: (() => void) | null = null;
let copied: string[] = [];
let savedClipboard: PropertyDescriptor | undefined;

beforeAll(() => {
  if (!hasDom) return;
  restoreParser = installInertDiagramSvgParser();
  setMermaidRuntime(
    { initialize() {}, render: () => Promise.resolve({ svg: SVG }) } as unknown as Parameters<typeof setMermaidRuntime>[0],
    'host',
  );
});

afterAll(() => {
  if (!hasDom) return;
  __setMermaidRuntimeLoaderForTests(undefined);
  restoreParser?.();
});

beforeEach(() => {
  if (!hasDom) return;
  copied = [];
  savedClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
});

afterEach(async () => {
  if (!hasDom) return;
  if (savedClipboard) Object.defineProperty(navigator, 'clipboard', savedClipboard);
  else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
  if (root !== null) {
    const finished = root;
    await act(async () => finished.unmount());
    root = null;
  }
  host?.remove();
  host = null;
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

async function mountDiagram(): Promise<void> {
  const block = parseMarkdownToBlocks(['```mermaid', SOURCE, '```'].join('\n')).find((b) => b.type === 'code');
  if (block === undefined) throw new Error('no fence');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<MermaidBlock block={block} />));
  for (let i = 0; i < 20 && host.querySelector('svg') === null; i += 1) await settle();
}

async function press(label: string): Promise<void> {
  const button = host!.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (button === null) throw new Error(`no ${label} button`);
  await act(async () => button.click());
  await settle();
}

test.skipIf(!hasDom)('Copy source on the drawn diagram copies the fence text', async () => {
  await mountDiagram();
  await press('Copy source');
  expect(copied).toEqual([SOURCE]);
});

test.skipIf(!hasDom)('Copy source in the source view copies the fence text', async () => {
  await mountDiagram();
  await press('Show source');
  await press('Copy source');
  expect(copied).toEqual([SOURCE]);
});
