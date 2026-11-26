/** DOM coverage for a chapter's files grouped by kind (code, tests, generated). */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GuideSection } from '@plannotator/core/guide';
import type { DiffFile } from './types';
import { GuideHostProvider, type GuideHostValue } from './host';
import { GuideViewportProvider } from './GuideViewportManager';
import { GuideSectionCard } from './GuideSectionCard';

const hasDom = typeof document !== 'undefined';
let mountedProps: Record<string, unknown>[] = [];
/** Each mount of the renderer (not each render), by file path. */
let mounts: string[] = [];

function FakeDiffRenderer(props: Record<string, unknown>) {
  mountedProps.push(props);
  const path = (props.files as DiffFile[])[0].path;
  React.useEffect(() => {
    mounts.push(path);
  }, []);
  return <div data-testid="file-code-view" />;
}

const makeFile = (path: string): DiffFile => ({
  path,
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
  additions: 1,
  deletions: 1,
  status: 'modified',
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  mountedProps = [];
  mounts = [];
});

async function renderChapter(paths: string[], generatedFiles?: ReadonlySet<string>, collapseAll?: GuideHostValue<Record<string, unknown>>['collapseAll'], keepsFileOrder?: boolean, eager = true) {
  const files = paths.map(makeFile);
  const section: GuideSection = { title: 'Chapter', overview: '', diffs: paths.map((file) => ({ file })) };
  const value: GuideHostValue<Record<string, unknown>> = {
    files,
    DiffRenderer: FakeDiffRenderer as unknown as GuideHostValue<Record<string, unknown>>['DiffRenderer'],
    getDiffRendererProps: () => ({}),
    generatedFiles,
    collapseAll,
    keepsFileOrder,
  };
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
  }
  await act(async () => {
    root ??= createRoot(host!);
    root.render(
      <GuideHostProvider value={value}>
        <GuideViewportProvider eager={eager}>
          <GuideSectionCard
            section={section}
            files={files}
            index={0}
            total={1}
            focusedFile={null}
            revealTarget={null}
            onActivate={() => {}}
            onRequestReveal={() => {}}
          />
        </GuideViewportProvider>
      </GuideHostProvider>,
    );
  });
  return host;
}

const subheads = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('[data-guide-kind-subhead]')].map((s) => s.textContent);
const chipNames = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('button[title]')]
    .map((chip) => chip.title.split('\n')[0])
    .filter((title) => title.includes('.'));
const cardOrder = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('[data-guide-file-shell]')].map((shell) => shell.dataset.guideFileShell);

describe('GuideSectionCard file kinds', () => {
  test.skipIf(!hasDom)('one kind: no subheads, the author order unchanged', async () => {
    const paths = ['src/b.ts', 'src/a.ts'];
    const el = await renderChapter(paths);
    expect(subheads(el)).toEqual([]);
    expect(chipNames(el)).toEqual(paths);
    expect(cardOrder(el)).toEqual(paths);
  });

  test.skipIf(!hasDom)('mixed kinds: code first, then "Tests N", then "Generated N"; author order kept inside each', async () => {
    const el = await renderChapter([
      'src/retry.test.ts',
      'src/retry.ts',
      'bun.lock',
      'tests/e2e/sync.spec.ts',
      'src/backoff.ts',
    ]);
    const expected = ['src/retry.ts', 'src/backoff.ts', 'src/retry.test.ts', 'tests/e2e/sync.spec.ts', 'bun.lock'];
    expect(subheads(el)).toEqual(['Tests2', 'Generated1']);
    expect(chipNames(el)).toEqual(expected);
    expect(cardOrder(el)).toEqual(expected);
  });

  test.skipIf(!hasDom)('a host that keeps the file order (the PR page, whose rail lists them) draws the cards in the order given', async () => {
    const paths = ['docs/rtl.md', 'src/Layout.tsx', 'src/Profile.test.tsx', 'src/Profile.tsx'];
    const el = await renderChapter(paths, undefined, undefined, true);
    expect(cardOrder(el)).toEqual(paths);
  });

  test.skipIf(!hasDom)('test cards open, generated cards start folded', async () => {
    const el = await renderChapter(['src/a.ts', 'src/a.test.ts', 'bun.lock']);
    const collapsedFor = (path: string) => mountedProps.find((p) => (p.files as DiffFile[])[0].path === path)?.mountCollapsed;
    expect(collapsedFor('src/a.ts')).toBe(false);
    expect(collapsedFor('src/a.test.ts')).toBe(false);
    expect(collapsedFor('bun.lock')).toBe(true);
    expect(el.querySelectorAll('[data-guide-kind-subhead] [data-file-kind-icon]').length).toBe(2);
  });

  test.skipIf(!hasDom)('a file box says whether it is folded before its viewer is drawn, and after Collapse all', async () => {
    // The first two files draw at once (the first paint); the rest wait for the view.
    const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'bun.lock'];
    const folded = (el: HTMLElement) =>
      Object.fromEntries([...el.querySelectorAll<HTMLElement>('[data-guide-file-shell]')].map((shell) => [shell.dataset.guideFileShell, shell.dataset.guideFileFolded]));
    // An observer that never reports a file near the view: no viewer is drawn.
    const realObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    try {
      const el = await renderChapter(paths, undefined, undefined, undefined, false);
      // c and the lockfile not drawn yet: no viewer, so no folding arrow; the box says it.
      expect(mounts.sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(folded(el)).toEqual({ 'src/a.ts': 'false', 'src/b.ts': 'false', 'src/c.ts': 'false', 'bun.lock': 'true' });
      await renderChapter(paths, undefined, { collapsed: true, token: 1 }, undefined, false);
      expect(folded(el)).toEqual({ 'src/a.ts': 'true', 'src/b.ts': 'true', 'src/c.ts': 'true', 'bun.lock': 'true' });
      await renderChapter(paths, undefined, { collapsed: false, token: 2 }, undefined, false);
      expect(folded(el)).toEqual({ 'src/a.ts': 'false', 'src/b.ts': 'false', 'src/c.ts': 'false', 'bun.lock': 'false' });
      expect(mounts.filter((path) => path === 'src/c.ts' || path === 'bun.lock')).toEqual([]);
    } finally {
      globalThis.IntersectionObserver = realObserver;
    }
  });

  test.skipIf(!hasDom)("the host's generated set decides what is generated", async () => {
    const el = await renderChapter(['src/schema.gen.ts', 'bun.lock'], new Set(['src/schema.gen.ts']));
    expect(subheads(el)).toEqual(['Generated1']);
    expect(cardOrder(el)).toEqual(['bun.lock', 'src/schema.gen.ts']);
  });

  test.skipIf(!hasDom)('Collapse all / Expand all mount again only the files whose state changes', async () => {
    const paths = ['src/a.ts', 'bun.lock'];
    await renderChapter(paths);
    expect(mounts.sort()).toEqual(['bun.lock', 'src/a.ts']);
    const lastCollapsed = (path: string) => mountedProps.filter((p) => (p.files as DiffFile[])[0].path === path).at(-1)?.mountCollapsed;

    // Expand all: the folded generated file opens; the open one keeps its viewer (its opened gaps, an open comment).
    mounts = [];
    await renderChapter(paths, undefined, { collapsed: false, token: 1 });
    expect(mounts).toEqual(['bun.lock']);
    expect(lastCollapsed('bun.lock')).toBe(false);

    // Collapse all: both change, both fold.
    mounts = [];
    await renderChapter(paths, undefined, { collapsed: true, token: 2 });
    expect(mounts.sort()).toEqual(['bun.lock', 'src/a.ts']);
    expect(lastCollapsed('src/a.ts')).toBe(true);
    expect(lastCollapsed('bun.lock')).toBe(true);
  });
});
