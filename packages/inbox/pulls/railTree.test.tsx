/**
 * The PR page's file rail. What regresses: a row losing its +/- (the size of each change is what the rail is read
 * for), a folder losing its sums, and a long path cut where it tells rows apart (its end) rather than in its middle.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Where a name gives way on screen is the
 * e2e spec's (`inbox-pull-requests.spec.ts`, "the rail: a long path gives way in its middle").
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { reviewFiles } from './reviewFiles';

const hasDom = typeof document !== 'undefined';
const { RailTree, middleCut } = (hasDom ? await import('./RailTree') : {}) as typeof import('./RailTree');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  if (!hasDom) return;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root.unmount());
  host.remove();
});

const file = (path: string, add: number, del: number) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${del} +1,${add} @@\n${'-old\n'.repeat(del)}${'+new\n'.repeat(add)}`;

function draw(patch: string) {
  const { files, tree, loose } = reviewFiles(patch);
  act(() =>
    root.render(<RailTree tree={tree} loose={loose} files={files} viewed={new Set()} commentCount={() => 0} onSelect={() => {}} onToggleViewed={() => {}} />),
  );
}
const counts = (row: Element | null | undefined) => [...(row?.querySelectorAll('.review-count-columns > span') ?? [])].map((cell) => cell.textContent);

test.if(hasDom)("each file shows its +/- in the review app's columns, and each folder its quiet sums", () => {
  draw([file('crates/core-api/src/form_actions.rs', 22, 0), file('crates/bundler/src/shared_chunk_ids.rs', 38, 21), file('crates/bundler/src/worker.rs', 3, 4)].join(''));
  const row = (path: string) => host.querySelector(`[data-review-file="${path}"]`);
  expect(counts(row('crates/core-api/src/form_actions.rs'))).toEqual(['+22', '']);
  expect(counts(row('crates/bundler/src/shared_chunk_ids.rs'))).toEqual(['+38', '-21']);
  expect(row('crates/bundler/src/shared_chunk_ids.rs')!.querySelector('.review-count-columns')!.getAttribute('data-count-columns')).toBe('color');
  const folder = host.querySelector('[data-review-folder] .ib-prp-folder');
  expect(counts(folder)).toEqual(['+63', '-25']);
  expect(folder!.querySelector('.review-count-columns')!.getAttribute('data-count-columns')).toBe('quiet');
});

test.if(hasDom)('a row holds the whole path, cut only where it may give way: the folder before its last one, the name before its end', () => {
  const path = 'test/e2e/app-shell/render-worker-reads-own-source/render-worker-reads-own-source.test.ts';
  draw([file(path, 1, 0), file('src/one.ts', 1, 0)].join(''));
  const row = host.querySelector(`[data-review-file="${path}"]`)!;
  expect(row.querySelector('.ib-prp-fname')!.textContent).toBe(path);
  expect(row.querySelector('.ib-prp-dir .ib-prp-keep')!.textContent).toBe('/render-worker-reads-own-source/');
  expect(row.querySelector('.ib-prp-base .ib-prp-keep')!.textContent).toBe('.test.ts');
  // A last folder too long for the row on its own keeps its end too: it gives way in its own middle.
  expect(row.querySelector('.ib-prp-dir .ib-prp-end')!.textContent).toBe('-source/');
  // Nothing on the row fades or reads right to left.
  expect(row.querySelector('[class*="ib-rv-name"]')).toBeNull();
});

test.if(hasDom)('middleCut keeps the end that tells rows apart', () => {
  // The slash stays with the end, so a cut folder still reads as a path ("crates/c…/src/").
  expect(middleCut('crates/core-api/src/')).toEqual(['crates/core-api', '/src/']);
  expect(middleCut('bundler/crates')).toEqual(['bundler', '/crates']);
  expect(middleCut('shared_chunk_ids.rs')).toEqual(['shared_chunk', '_ids.rs']);
  expect(middleCut('mod.rs')).toEqual(['mod.rs', '']);
});

test.if(hasDom)("a row counts other people's open threads on its file, apart from the person's own comments, and says it to a screen reader", () => {
  const { files, tree, loose } = reviewFiles([file('src/a.ts', 1, 0), file('src/b.ts', 1, 0)].join(''));
  act(() =>
    root.render(<RailTree tree={tree} loose={loose} files={files} viewed={new Set()} commentCount={(path) => (path === 'src/a.ts' ? 2 : 0)} threadCount={(path) => (path === 'src/a.ts' ? 6 : 0)} onSelect={() => {}} onToggleViewed={() => {}} />),
  );
  const a = host.querySelector('[data-review-file="src/a.ts"]')!;
  expect(a.querySelector('[data-pull-file-threads]')!.textContent).toBe('6');
  expect(a.querySelector('.ib-prp-c')!.textContent).toBe('2');
  expect(a.getAttribute('aria-label')).toBe('src/a.ts, 6 open threads');
  const b = host.querySelector('[data-review-file="src/b.ts"]')!;
  expect(b.querySelector('[data-pull-file-threads]')).toBeNull();
  expect(b.getAttribute('aria-label')).toBe('src/b.ts');
});
