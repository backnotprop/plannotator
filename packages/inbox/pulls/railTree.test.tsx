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
  draw([file('crates/next-api/src/server_actions.rs', 22, 0), file('crates/turbopack/src/global_module_ids.rs', 38, 21), file('crates/turbopack/src/worker.rs', 3, 4)].join(''));
  const row = (path: string) => host.querySelector(`[data-review-file="${path}"]`);
  expect(counts(row('crates/next-api/src/server_actions.rs'))).toEqual(['+22', '']);
  expect(counts(row('crates/turbopack/src/global_module_ids.rs'))).toEqual(['+38', '-21']);
  expect(row('crates/turbopack/src/global_module_ids.rs')!.querySelector('.review-count-columns')!.getAttribute('data-count-columns')).toBe('color');
  const folder = host.querySelector('[data-review-folder] .ib-prp-folder');
  expect(counts(folder)).toEqual(['+63', '-25']);
  expect(folder!.querySelector('.review-count-columns')!.getAttribute('data-count-columns')).toBe('quiet');
  // The columns are as wide as the rail's widest numbers, so they line up down the rail.
  expect((host.querySelector('.ib-prp-files') as HTMLElement).style.getPropertyValue('--count-add-w')).toBe('calc(3ch + 2px)');
});

test.if(hasDom)('a row holds the whole path, cut only where it may give way: the folder before its last one, the name before its end', () => {
  const path = 'test/e2e/app-dir/turbopack-worker-self-reference/turbopack-worker-self-reference.test.ts';
  draw([file(path, 1, 0), file('src/one.ts', 1, 0)].join(''));
  const row = host.querySelector(`[data-review-file="${path}"]`)!;
  expect(row.querySelector('.ib-prp-fname')!.textContent).toBe(path);
  expect(row.querySelector('.ib-prp-dir .ib-prp-keep')!.textContent).toBe('turbopack-worker-self-reference/');
  expect(row.querySelector('.ib-prp-base .ib-prp-keep')!.textContent).toBe('.test.ts');
  // Nothing on the row fades or reads right to left.
  expect(row.querySelector('[class*="ib-rv-name"]')).toBeNull();
});

test.if(hasDom)('middleCut keeps the end that tells rows apart', () => {
  expect(middleCut('crates/next-api/src/')).toEqual(['crates/next-api/', 'src/']);
  expect(middleCut('turbopack/crates')).toEqual(['turbopack/', 'crates']);
  expect(middleCut('global_module_ids.rs')).toEqual(['global_module', '_ids.rs']);
  expect(middleCut('mod.rs')).toEqual(['mod.rs', '']);
});
