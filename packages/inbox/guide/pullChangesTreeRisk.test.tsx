/**
 * The risk bars in the PR page's Changes tree (approval "review-risk-bars"). What regresses: the mark on a file the
 * judgment does not name, on a row twice, left behind when the judgment goes, or any lead drawn with no judgment (the
 * review app's tree draws none).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffFile } from '@plannotator/core/diff-files';
import { markFirstCodePainted } from '@plannotator/review-editor/utils/firstCodePaint';
import { PullChangesTree } from './PullChangesTree';
import type { PullTreeRisk } from './pullRepoTypes';

markFirstCodePainted();

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const file = (path: string): DiffFile => ({ path, patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1, status: 'modified' });
const FILES = [file('src/billing.ts'), file('src/auth.ts'), file('README.md')];
const NO_VIEWED = new Set<string>();

const tree = (risk?: PullTreeRisk | null) => (
  <PullChangesTree files={FILES} viewed={NO_VIEWED} showViewed comments={[]} activePath={null} head={null} onSelect={() => {}} risk={risk} />
);

async function draw(element: ReactElement) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => root?.render(element));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return host;
}

const rowsOf = (el: HTMLElement) => [...el.querySelector<HTMLElement>('[data-changes-tree]')!.shadowRoot!.querySelectorAll<HTMLElement>('[data-type="item"]')];
const marked = (el: HTMLElement) =>
  rowsOf(el).flatMap((row) => [...row.querySelectorAll<HTMLElement>('[data-item-part-id="risk"]')].map((mark) => `${row.dataset.itemPath} ${mark.getAttribute('title')}`));

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.skipIf(!hasDom)('the risk bars in the Changes tree', () => {
  test('once on each named file, before its name, and on no other row', async () => {
    const el = await draw(tree({ level: 'high', files: new Set(['src/billing.ts', 'README.md']) }));
    expect(marked(el).sort()).toEqual(['README.md High risk', 'src/billing.ts High risk'].sort());
    const billing = rowsOf(el).find((row) => row.dataset.itemPath?.endsWith('billing.ts'))!;
    const sections = [...billing.querySelectorAll<HTMLElement>('[data-item-section]')].map((s) => s.dataset.itemSection);
    expect(sections.indexOf('lead')).toBeLessThan(sections.indexOf('content'));
    // The row's title, the description a screen reader reads, says it too; a mark, not a button.
    expect(billing.getAttribute('title')).toBe('src/billing.ts · High risk');
    expect(billing.querySelector('[data-item-part-id="risk"]')!.getAttribute('role')).toBeNull();
  });

  test('Medium says Medium; with no judgment the rows draw no lead at all, and a gone judgment takes its marks', async () => {
    const el = await draw(tree({ level: 'medium', files: new Set(['src/auth.ts']) }));
    expect(marked(el).map((m) => m.replace(/^.*?auth\.ts /, ''))).toEqual(['Medium risk']);
    await draw(tree(null));
    expect(marked(el)).toEqual([]);
    expect(rowsOf(el).some((row) => row.querySelector('[data-item-section="lead"]'))).toBe(false);
  });

  test('a marked file at the root makes the tree room for its mark; one inside a folder, or none, does not', async () => {
    const roomy = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-changes-tree]')!.hasAttribute('data-lead-room');
    const el = await draw(tree({ level: 'high', files: new Set(['README.md']) }));
    expect(roomy(el)).toBe(true);
    await draw(tree({ level: 'high', files: new Set(['src/billing.ts']) }));
    expect(roomy(el)).toBe(false);
    await draw(tree(null));
    expect(roomy(el)).toBe(false);
  });
});
