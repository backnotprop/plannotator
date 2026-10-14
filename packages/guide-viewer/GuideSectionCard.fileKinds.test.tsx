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

function FakeDiffRenderer(props: Record<string, unknown>) {
  mountedProps.push(props);
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
});

async function renderChapter(paths: string[], generatedFiles?: ReadonlySet<string>) {
  const files = paths.map(makeFile);
  const section: GuideSection = { title: 'Chapter', overview: '', diffs: paths.map((file) => ({ file })) };
  const value: GuideHostValue<Record<string, unknown>> = {
    files,
    DiffRenderer: FakeDiffRenderer as unknown as GuideHostValue<Record<string, unknown>>['DiffRenderer'],
    getDiffRendererProps: () => ({}),
    generatedFiles,
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <GuideHostProvider value={value}>
        <GuideViewportProvider eager>
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

  test.skipIf(!hasDom)('test cards open, generated cards start folded', async () => {
    const el = await renderChapter(['src/a.ts', 'src/a.test.ts', 'bun.lock']);
    const collapsedFor = (path: string) => mountedProps.find((p) => (p.files as DiffFile[])[0].path === path)?.mountCollapsed;
    expect(collapsedFor('src/a.ts')).toBe(false);
    expect(collapsedFor('src/a.test.ts')).toBe(false);
    expect(collapsedFor('bun.lock')).toBe(true);
    expect(el.querySelectorAll('[data-guide-kind-subhead] [data-file-kind-icon]').length).toBe(2);
  });

  test.skipIf(!hasDom)("the host's generated set decides what is generated", async () => {
    const el = await renderChapter(['src/schema.gen.ts', 'bun.lock'], new Set(['src/schema.gen.ts']));
    expect(subheads(el)).toEqual(['Generated1']);
    expect(cardOrder(el)).toEqual(['bun.lock', 'src/schema.gen.ts']);
  });
});
