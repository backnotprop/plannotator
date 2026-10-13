/**
 * PlanCleanDiffView's optional seams (`renderBlock`, `lineGutter`,
 * `foldUnchanged`, `unchangedClassName`) for code review's rendered Markdown
 * diff. Plan review passes none of them and must render exactly as before:
 * no gutter, no fold rows, and the old unchanged-block dimming.
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlanCleanDiffView, type PlanDiffBlockRenderer } from './PlanCleanDiffView';
import { computePlanDiff } from '../../utils/planDiffEngine';

const hasDom = typeof document !== 'undefined';

const sections = (n: number) =>
  Array.from({ length: n }, (_, i) => `## Section ${i + 1}\n\nText ${i + 1}.\n`).join('\n');
const OLD = `${sections(5)}\nOld closing paragraph.\n\nGone paragraph.\n`;
const NEW = `${sections(5)}\nNew closing paragraph.\n\nAdded paragraph.\n`;

describe.if(hasDom)('PlanCleanDiffView seams (DOM)', () => {
  let roots: Root[] = [];
  let hosts: HTMLElement[] = [];

  async function render(node: React.ReactElement): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    hosts.push(host);
    await act(async () => {
      root.render(node);
    });
    return host;
  }

  afterEach(async () => {
    for (const root of roots) await act(async () => root.unmount());
    for (const host of hosts) host.remove();
    roots = [];
    hosts = [];
  });

  test('without the new props: no gutter, no fold rows, the old unchanged dimming', async () => {
    const { blocks } = computePlanDiff(OLD, NEW);
    const el = await render(<PlanCleanDiffView blocks={blocks} wordLevel={false} />);
    expect(el.querySelector('[data-plan-diff-gutter]')).toBeNull();
    expect(el.querySelector('[data-plan-diff-fold]')).toBeNull();
    const unchanged = el.querySelector('.plan-diff-unchanged')!;
    expect(unchanged.className).toBe('plan-diff-unchanged opacity-60 hover:opacity-100 transition-opacity');
    // Every block renders directly under the list (no gutter wrappers).
    const root = el.firstElementChild!;
    expect(root.className).toBe('space-y-1');
    expect(Array.from(root.children).every((child) => !child.querySelector(':scope > [data-plan-diff-gutter]'))).toBe(true);
    expect(root.children.length).toBe(blocks.length);
    // All five sections are on screen.
    expect(el.textContent).toContain('Section 1');
    expect(el.textContent).toContain('Section 5');
  });

  test('lineGutter labels each block with its source lines', async () => {
    const { blocks } = computePlanDiff('Intro.\n\nOld line.\n\nGone.\n', 'Intro.\n\nNew line.\n\nTail.\n\nMore.\n');
    const el = await render(<PlanCleanDiffView blocks={blocks} wordLevel={false} lineGutter />);
    const labels = Array.from(el.querySelectorAll('[data-plan-diff-gutter]')).map((g) =>
      Array.from(g.children).map((line) => line.textContent),
    );
    // Intro (1), modified block (new 3–7 over old 3–5): what diffLines paired.
    expect(labels[0]).toEqual(['1']);
    expect(labels.some((l) => l.some((line) => line?.startsWith('old ')))).toBe(true);
    const gutter = el.querySelector('[data-plan-diff-gutter]')!;
    expect(gutter.getAttribute('aria-hidden')).toBe('true');
    // Excluded from annotation quotes and never selectable.
    expect(gutter.classList.contains('annotation-exclude')).toBe(true);
    expect(gutter.classList.contains('select-none')).toBe(true);
  });

  test('a removed block is labelled with its old lines', async () => {
    const { blocks } = computePlanDiff('Keep.\n\nDrop me.\n', 'Keep.\n');
    const el = await render(<PlanCleanDiffView blocks={blocks} lineGutter />);
    const texts = Array.from(el.querySelectorAll('[data-plan-diff-gutter]')).map((g) => g.textContent);
    expect(texts).toContain('old 3');
  });

  test('foldUnchanged hides long unchanged runs behind a row that expands in place', async () => {
    const { blocks } = computePlanDiff(OLD, NEW);
    const el = await render(<PlanCleanDiffView blocks={blocks} wordLevel={false} foldUnchanged lineGutter />);
    const row = el.querySelector<HTMLButtonElement>('[data-plan-diff-fold]')!;
    expect(row).not.toBeNull();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(row.textContent).toContain('unchanged sections');
    expect(row.textContent).toContain('Section 1 · Section 2 · Section 3');
    expect(row.textContent).toContain('Show');
    expect(el.textContent).not.toContain('Text 1.');
    // Context next to the change stays visible.
    expect(el.textContent).toContain('Text 5.');

    await act(async () => row.click());
    expect(el.textContent).toContain('Text 1.');
    const hide = el.querySelector<HTMLButtonElement>('[data-plan-diff-fold]')!;
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(hide.textContent).toMatch(/^Hide \d+ unchanged sections$/);

    await act(async () => hide.click());
    expect(el.textContent).not.toContain('Text 1.');
  });

  test('renderBlock renders every parsed block and names the side it came from', async () => {
    const { blocks } = computePlanDiff('Keep.\n\nOld text.\n', 'Keep.\n\nNew text.\n');
    const seen: { content: string; side: string }[] = [];
    const renderBlock: PlanDiffBlockRenderer = (block, _orderedIndex, side) => {
      seen.push({ content: block.content, side });
      return <p data-host-block={side}>{block.content}</p>;
    };
    const el = await render(<PlanCleanDiffView blocks={blocks} wordLevel={false} renderBlock={renderBlock} />);
    expect(el.querySelector('[data-host-block="old"]')?.textContent).toBe('Old text.');
    expect(el.querySelector('[data-host-block="new"]')?.textContent).toBe('Keep.');
    expect(seen).toContainEqual({ content: 'New text.', side: 'new' });
  });

  test('unchangedClassName replaces the default dimming', async () => {
    const { blocks } = computePlanDiff('Keep.\n\nA\n', 'Keep.\n\nB\n');
    const el = await render(<PlanCleanDiffView blocks={blocks} unchangedClassName="opacity-80" />);
    expect(el.querySelector('.plan-diff-unchanged')!.className).toBe('plan-diff-unchanged opacity-80');
  });
});
