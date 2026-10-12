/**
 * The Markdown preview's state and keys: Source everywhere until the
 * "Preview .md" switch is pressed, which is remembered (cookie only); a
 * file's own choice wins until the switch is pressed again; `P` toggles the
 * current Markdown file and `Shift+P` the switch.
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import type { DiffFile } from '../types';
import {
  MARKDOWN_PREVIEW_ALL_COOKIE,
  useMarkdownPreview,
  useMarkdownPreviewKeys,
  type MarkdownPreviewController,
} from './useMarkdownPreview';

const hasDom = typeof document !== 'undefined';

const file = (path: string): DiffFile => ({ path, patch: '', additions: 1, deletions: 0, status: 'modified' });
const FILES = [file('docs/a.md'), file('docs/b.md'), file('src/c.ts')];

let stored: Map<string, string>;
let root: Root | null = null;
let host: HTMLElement | null = null;
let controller: MarkdownPreviewController | undefined;

function Harness({ supported = true, targetPath = 'docs/a.md', enabled = true }: { supported?: boolean; targetPath?: string | null; enabled?: boolean }) {
  controller = useMarkdownPreview({ files: FILES, supported });
  useMarkdownPreviewKeys({ controller, targetPath, files: FILES, enabled });
  return <input data-test-input="" />;
}

async function mount(props: React.ComponentProps<typeof Harness> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Harness {...props} />));
}

async function remount(props: React.ComponentProps<typeof Harness> = {}) {
  await act(async () => root!.unmount());
  root = createRoot(host!);
  await act(async () => root!.render(<Harness {...props} />));
}

async function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  stored = new Map();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
    removeItem: (key) => { stored.delete(key); },
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  controller = undefined;
  resetStorageBackend();
});

describe.if(hasDom)('Markdown preview state and keys', () => {
  test('Source everywhere by default; the switch is remembered once pressed', async () => {
    await mount();
    expect(controller!.all).toBe(false);
    expect([...controller!.previewedPaths]).toEqual([]);

    await act(async () => controller!.toggleAll());
    expect([...controller!.previewedPaths].sort()).toEqual(['docs/a.md', 'docs/b.md']);
    expect(stored.get(MARKDOWN_PREVIEW_ALL_COOKIE)).toBe('true');

    // A later review starts from the remembered switch.
    await remount();
    expect(controller!.all).toBe(true);
    expect(controller!.isPreviewed('docs/a.md')).toBe(true);
    expect(controller!.isPreviewed('src/c.ts')).toBe(false);
  });

  test("a file's own choice wins until the switch is pressed again", async () => {
    await mount();
    await act(async () => controller!.toggleAll()); // every Markdown file on
    await act(async () => controller!.toggleFile('docs/b.md')); // b back to Source
    expect(controller!.isPreviewed('docs/a.md')).toBe(true);
    expect(controller!.isPreviewed('docs/b.md')).toBe(false);

    await act(async () => controller!.toggleAll()); // every file follows the switch: off
    await act(async () => controller!.toggleAll()); // and on again
    expect(controller!.isPreviewed('docs/b.md')).toBe(true);
  });

  test('P toggles the current Markdown file, Shift+P every Markdown file', async () => {
    await mount({ targetPath: 'docs/a.md' });
    await press('p');
    expect([...controller!.previewedPaths]).toEqual(['docs/a.md']);
    await press('P', { shiftKey: true });
    expect(controller!.all).toBe(true);
    expect([...controller!.previewedPaths].sort()).toEqual(['docs/a.md', 'docs/b.md']);
  });

  test('P does nothing on a code file, while typing, or off the diff', async () => {
    await mount({ targetPath: 'src/c.ts' });
    await press('p');
    expect([...controller!.previewedPaths]).toEqual([]);

    await remount({ targetPath: 'docs/a.md' });
    const input = host!.querySelector('[data-test-input]')!;
    await press('p', {}, input);
    expect([...controller!.previewedPaths]).toEqual([]);

    await remount({ targetPath: 'docs/a.md', enabled: false });
    await press('p');
    expect([...controller!.previewedPaths]).toEqual([]);
  });

  test('a server without the advert gets no preview at all', async () => {
    await mount({ supported: false });
    expect(controller).toBeUndefined();
  });
});
