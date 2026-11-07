import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OverlayScrollArea } from './OverlayScrollArea';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const positions = new Map<string, number>();
  async function render(tab: string | null, enabled = true) {
    await act(async () => root?.render(tab === null ? null : <OverlayScrollArea
      scrollMemory={enabled ? { positions, key: tab } : undefined}
    ><div>{tab} rows</div></OverlayScrollArea>));
    return host!.firstElementChild as HTMLElement;
  }
  return render;
}

function scroll(node: HTMLElement, top: number) {
  node.scrollTop = top;
  node.dispatchEvent(new Event('scroll'));
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.if(hasDom)('navigation scroll memory', () => {
  test('restores a closed and remounted list to its last position', async () => {
    const render = await mount();
    const original = await render('contents');
    scroll(original, 360);
    await render(null);
    const reopened = await render('contents');
    expect(reopened).not.toBe(original);
    expect(reopened.scrollTop).toBe(360);
  });

  test('each tab keeps its own position when sharing the same viewport', async () => {
    const render = await mount();
    const contents = await render('contents');
    scroll(contents, 240);
    const files = await render('files');
    expect(files).toBe(contents);
    expect(files.scrollTop).toBe(0);
    scroll(files, 510);
    expect((await render('contents')).scrollTop).toBe(240);
    expect((await render('files')).scrollTop).toBe(510);
  });

  test('captures the final position even if its scroll event has not fired before closing', async () => {
    const render = await mount();
    const original = await render('contents');
    scroll(original, 200);
    original.scrollTop = 280;
    await render(null);
    expect((await render('contents')).scrollTop).toBe(280);
  });

  test('unrelated parent renders do not interrupt the current scroll position', async () => {
    const render = await mount();
    const original = await render('contents');
    scroll(original, 120);
    original.scrollTop = 170;
    expect((await render('contents')).scrollTop).toBe(170);
  });

  test('without opt-in, parent updates leave incumbent scrolling untouched', async () => {
    const render = await mount();
    const original = await render('contents', false);
    scroll(original, 190);
    expect((await render('files', false)).scrollTop).toBe(190);
  });
});
