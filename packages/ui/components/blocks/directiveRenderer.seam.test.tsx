/**
 * Seam test: DirectiveRenderer (setDirectiveRenderer / resetDirectiveRenderer,
 * and the `directiveRenderer` key on configurePlannotatorUI).
 *
 * Contract: with no renderer registered, a `:::kind` block that is not a
 * question renders as the callout it always has. After a renderer is
 * registered, the node it returns for a block is drawn inside that block's
 * own element (which keeps `data-block-id`, so the block stays one
 * annotatable block); returning `undefined` leaves the block to the callout;
 * a question directive is never offered to it.
 *
 * Requires DOM (happy-dom) — runs under bun test (preloaded via bunfig.toml).
 *
 * Function references are captured at module load (top level) so they stay
 * valid when another test's mock.module() replaces module exports later.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BlockRenderer } from '../BlockRenderer';
import { configurePlannotatorUI } from '../../configure';
import { parseMarkdownToBlocks } from '../../utils/parser';
import * as DirectiveRendererModule from './directiveRenderer';

const setDirectiveRenderer = DirectiveRendererModule.setDirectiveRenderer;
const resetDirectiveRenderer = DirectiveRendererModule.resetDirectiveRenderer;

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;

afterEach(() => {
  resetDirectiveRenderer();
  if (root) { act(() => root!.unmount()); root = null; }
  if (hasDom) document.body.innerHTML = '';
});

async function render(markdown: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const blocks = parseMarkdownToBlocks(markdown);
  await act(async () => {
    root = createRoot(host);
    root.render(<>{blocks.map((block) => <BlockRenderer key={block.id} block={block} />)}</>);
  });
  return host;
}

const WIDGET = ':::widget\nname: gauge\n:::';

describe('DirectiveRenderer seam', () => {
  test.skipIf(!hasDom)('default: no renderer, the block is the callout it always was', async () => {
    const host = await render(WIDGET);
    const block = host.querySelector<HTMLElement>('[data-directive-kind="widget"]')!;
    expect(block.classList.contains('directive-widget')).toBe(true);
    expect(block.textContent).toContain('name: gauge');
  });

  test.skipIf(!hasDom)('a registered renderer draws its node inside the block, which keeps its id', async () => {
    const seen: string[] = [];
    setDirectiveRenderer((block) => {
      seen.push(`${block.directiveKind}|${block.content}`);
      return <span data-host-widget="">drawn by the host</span>;
    });
    const host = await render(`Before.\n\n${WIDGET}\n\nAfter.`);
    expect(seen).toEqual(['widget|name: gauge']);
    const drawn = host.querySelector<HTMLElement>('[data-host-widget]')!;
    const block = drawn.closest<HTMLElement>('[data-block-id]')!;
    expect(block.dataset.directiveKind).toBe('widget');
    expect(block.dataset.blockType).toBe('directive');
    expect(block.classList.contains('directive-widget')).toBe(false);
    expect(block.textContent).toBe('drawn by the host');
    expect(host.textContent).toContain('Before.');
    expect(host.textContent).toContain('After.');
  });

  test.skipIf(!hasDom)('a renderer that answers undefined leaves the block to the callout', async () => {
    setDirectiveRenderer((block) => (block.directiveKind === 'widget' ? undefined : <i data-other="" />));
    const host = await render(WIDGET);
    expect(host.querySelector('.directive-widget')).not.toBeNull();
    expect(host.querySelector('[data-other]')).toBeNull();
  });

  test.skipIf(!hasDom)('a question directive is never offered to the renderer', async () => {
    const seen: string[] = [];
    setDirectiveRenderer((block) => {
      seen.push(block.directiveKind ?? '');
      return <span data-host-widget="" />;
    });
    const host = await render(':::question\nWhich one?\n- A\n- B\n:::');
    expect(seen).toEqual([]);
    expect(host.querySelector('[data-host-widget]')).toBeNull();
    expect(host.textContent).toContain('Which one?');
  });

  test.skipIf(!hasDom)('configurePlannotatorUI({ directiveRenderer }) installs it', async () => {
    configurePlannotatorUI({ directiveRenderer: () => <span data-host-widget="" /> });
    const host = await render(WIDGET);
    expect(host.querySelector('[data-host-widget]')).not.toBeNull();
  });
});
