/**
 * Markdown file views (Source / Changes / Read): every file starts in Source;
 * a view picked on any file becomes the starting view for every file not set
 * by hand, remembered for the next review (cookie only); a file set by hand
 * keeps its view; an old "Preview .md" cookie that was on reads as Changes;
 * `P` steps the current file through its views.
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
  LEGACY_MARKDOWN_PREVIEW_ALL_COOKIE,
  MARKDOWN_VIEW_COOKIE,
  useMarkdownPreview,
  useMarkdownPreviewKeys,
  type MarkdownPreviewController,
} from './useMarkdownPreview';

const hasDom = typeof document !== 'undefined';

const file = (path: string, status: DiffFile['status'] = 'modified'): DiffFile => ({
  path, patch: '@@ -1 +1 @@\n-a\n+b\n', additions: 1, deletions: 1, status,
});
const FILES = [file('docs/a.md'), file('docs/b.md'), file('docs/new.md', 'added'), file('src/c.ts')];

let stored: Map<string, string>;
let root: Root | null = null;
let host: HTMLElement | null = null;
let controller: MarkdownPreviewController | undefined;

const lockedNotes: string[] = [];

function Harness({ supported = true, targetPath = 'docs/a.md', enabled = true }: { supported?: boolean; targetPath?: string | null | (() => string | null); enabled?: boolean }) {
  controller = useMarkdownPreview({ files: FILES, supported });
  useMarkdownPreviewKeys({ controller, targetPath, files: FILES, enabled, onLocked: (reason) => lockedNotes.push(reason) });
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

const views = () => ['docs/a.md', 'docs/b.md', 'docs/new.md'].map((path) => controller!.viewOf(path));

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
  lockedNotes.length = 0;
  resetStorageBackend();
});

describe.if(hasDom)('Markdown file views', () => {
  test('Source everywhere at first; a pick on one file sets the files not set by hand, and is remembered', async () => {
    await mount();
    expect(views()).toEqual(['source', 'source', 'source']);
    expect([...controller!.previewedPaths]).toEqual([]);

    await act(async () => controller!.choose('docs/a.md', 'changes'));
    // The added file has no Changes view: it follows as Read (still rendered).
    expect(views()).toEqual(['changes', 'changes', 'read']);
    expect(controller!.viewOf('src/c.ts')).toBe('source');
    expect([...controller!.previewedPaths].sort()).toEqual(['docs/a.md', 'docs/b.md', 'docs/new.md']);
    expect(stored.get(MARKDOWN_VIEW_COOKIE)).toBe('changes');

    // The next review starts there.
    await remount();
    expect(views()).toEqual(['changes', 'changes', 'read']);
  });

  test('a file set by hand keeps its view when another pick moves the rest', async () => {
    await mount();
    await act(async () => controller!.choose('docs/b.md', 'read'));
    await act(async () => controller!.choose('docs/a.md', 'source'));
    expect(views()).toEqual(['source', 'read', 'source']);
    await act(async () => controller!.choose('docs/new.md', 'read'));
    // a and b were set by hand; nothing else is left to follow.
    expect(views()).toEqual(['source', 'read', 'read']);
    expect(stored.get(MARKDOWN_VIEW_COOKIE)).toBe('read');
  });

  test('navigation shows a view on one file without moving the others or the memory', async () => {
    await mount();
    await act(async () => controller!.show('docs/a.md', 'read'));
    expect(views()).toEqual(['read', 'source', 'source']);
    expect(stored.has(MARKDOWN_VIEW_COOKIE)).toBe(false);
  });

  test('an old "Preview .md" cookie that was on starts files on Changes, under the new name', async () => {
    stored.set(LEGACY_MARKDOWN_PREVIEW_ALL_COOKIE, 'true');
    await mount();
    expect(views()).toEqual(['changes', 'changes', 'read']);
    expect(stored.get(MARKDOWN_VIEW_COOKIE)).toBe('changes');
    expect(stored.has(LEGACY_MARKDOWN_PREVIEW_ALL_COOKIE)).toBe(false);

    stored.clear();
    stored.set(LEGACY_MARKDOWN_PREVIEW_ALL_COOKIE, 'false');
    await remount();
    expect(views()).toEqual(['source', 'source', 'source']);
  });

  test('P steps the current file Source -> Changes -> Read -> Source, skipping Changes where there is none', async () => {
    await mount({ targetPath: 'docs/a.md' });
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await press('p');
      seen.push(controller!.viewOf('docs/a.md'));
    }
    expect(seen).toEqual(['changes', 'read', 'source']);
    // Each press is a pick: the last one is remembered.
    expect(stored.get(MARKDOWN_VIEW_COOKIE)).toBe('source');

    await remount({ targetPath: 'docs/new.md' });
    await press('p');
    expect(controller!.viewOf('docs/new.md')).toBe('read');
    await press('p');
    expect(controller!.viewOf('docs/new.md')).toBe('source');
  });

  test('P does nothing on a code file, while typing, off the diff, or with Shift', async () => {
    await mount({ targetPath: 'src/c.ts' });
    await press('p');
    expect([...controller!.previewedPaths]).toEqual([]);

    await remount({ targetPath: 'docs/a.md' });
    const input = host!.querySelector('[data-test-input]')!;
    await press('p', {}, input);
    await press('P', { shiftKey: true });
    expect([...controller!.previewedPaths]).toEqual([]);

    await remount({ targetPath: 'docs/a.md', enabled: false });
    await press('p');
    expect([...controller!.previewedPaths]).toEqual([]);
  });

  test('typing p in an editor inside a shadow root (the Pierre edit session) never switches the view', async () => {
    await mount({ targetPath: 'docs/a.md' });
    const shadowHost = document.createElement('div');
    document.body.appendChild(shadowHost);
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    shadow.appendChild(editor);
    // composed: the event reaches window retargeted to the shadow host.
    await press('p', { composed: true }, editor);
    expect(controller!.viewOf('docs/a.md')).toBe('source');
    shadowHost.remove();
  });

  test('the file the edit session holds keeps its view: P, a pick and navigation all leave it', async () => {
    await mount({ targetPath: 'docs/a.md' });
    await act(async () => controller!.setEditingFile('docs/a.md'));
    expect(controller!.lockReason('docs/a.md')).toBe('Finish editing first');
    expect(controller!.lockReason('docs/b.md')).toBeNull();
    await press('p');
    await act(async () => controller!.choose('docs/a.md', 'read'));
    await act(async () => controller!.show('docs/a.md', 'read'));
    expect(controller!.viewOf('docs/a.md')).toBe('source');
    expect(stored.has(MARKDOWN_VIEW_COOKIE)).toBe(false);

    // P on the locked file says why instead of doing nothing.
    expect(lockedNotes).toEqual(['Finish editing first']);

    await act(async () => controller!.setEditingFile(null));
    await press('p');
    expect(controller!.viewOf('docs/a.md')).toBe('changes');
  });

  test('a pick or P on another file moves the others but never the file being edited', async () => {
    await mount({ targetPath: 'docs/b.md' });
    await act(async () => controller!.setEditingFile('docs/a.md'));
    await act(async () => controller!.choose('docs/new.md', 'read'));
    // b and new follow the pick; a (being edited, never set by hand) keeps Source.
    expect(views()).toEqual(['source', 'read', 'read']);
    await press('p'); // b: Read -> Source
    await press('p'); // b: Source -> Changes
    expect(views()).toEqual(['source', 'changes', 'read']);
    expect(controller!.previewedPaths.has('docs/a.md')).toBe(false);

    // Once the edit ends the file keeps the view it was edited in, until picked.
    await act(async () => controller!.setEditingFile(null));
    expect(controller!.viewOf('docs/a.md')).toBe('source');
    await act(async () => controller!.choose('docs/a.md', 'read'));
    expect(controller!.viewOf('docs/a.md')).toBe('read');
  });

  test('in All files P reads its target when pressed', async () => {
    let target: string | null = 'docs/b.md';
    await mount({ targetPath: () => target });
    await press('p');
    expect(views()).toEqual(['changes', 'changes', 'read']);
    target = null;
    await press('p');
    expect(controller!.viewOf('docs/b.md')).toBe('changes');
  });

  test('a server without the advert gets no views at all', async () => {
    await mount({ supported: false });
    expect(controller).toBeUndefined();
  });
});
