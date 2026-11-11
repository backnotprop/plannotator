/**
 * DOM-gated tests (DOM_TESTS=1, listed in tests/dom-test-list.txt) for the
 * hold that keeps a just-viewed row in place under the pointer (#2713). The
 * pure rule is in useHiddenViewedFiles.test.ts; this guards the hook's state:
 * the pointer entering and leaving the panel, and a key press releasing it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useHiddenViewedFiles } from './useHiddenViewedFiles';

const hasDom = typeof document !== 'undefined';

type Api = ReturnType<typeof useHiddenViewedFiles>;
let root: Root | null = null;
let host: HTMLElement | null = null;
let renders = 0;

function Harness({ viewed, hide, out }: { viewed: Set<string>; hide: boolean; out: { current: Api | null } }) {
  renders++;
  out.current = useHiddenViewedFiles(viewed, hide);
  return null;
}

async function mount(viewed: Set<string>, hide: boolean) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const out: { current: Api | null } = { current: null };
  await act(async () => {
    root = createRoot(host!);
    root.render(<Harness viewed={viewed} hide={hide} out={out} />);
  });
  const rerender = (nextViewed: Set<string>, nextHide = hide) =>
    act(async () => root!.render(<Harness viewed={nextViewed} hide={nextHide} out={out} />));
  const hidden = () => [...out.current!.hiddenFiles].sort();
  const pointer = (event: 'onPointerEnter' | 'onPointerMove' | 'onPointerLeave') =>
    act(async () => (out.current!.panelPointerProps[event] as () => void)());
  return { out, rerender, hidden, pointer };
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('useHiddenViewedFiles', () => {
  test.skipIf(!hasDom)('the file you leave keeps its row while the pointer is in the panel, and goes when it leaves', async () => {
    const s = await mount(new Set(['a.ts']), true);
    expect(s.hidden()).toEqual(['a.ts']);
    await s.pointer('onPointerEnter');
    await s.rerender(new Set(['a.ts', 'c.ts']));
    expect(s.hidden()).toEqual(['a.ts']);
    await s.pointer('onPointerLeave');
    expect(s.hidden()).toEqual(['a.ts', 'c.ts']);
  });

  test.skipIf(!hasDom)('a key press in the panel releases the hold; the next pointer move holds again', async () => {
    const s = await mount(new Set<string>(), true);
    await s.pointer('onPointerEnter');
    await s.rerender(new Set(['a.ts']));
    expect(s.hidden()).toEqual([]);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
    expect(s.hidden()).toEqual(['a.ts']);
    await s.rerender(new Set(['a.ts', 'b.ts']));
    expect(s.hidden()).toEqual(['a.ts', 'b.ts']);
    await s.pointer('onPointerMove');
    await s.rerender(new Set(['a.ts', 'b.ts', 'c.ts']));
    expect(s.hidden()).toEqual(['a.ts', 'b.ts']);
  });

  test.skipIf(!hasDom)('turning Hide viewed on in the panel hides everything viewed', async () => {
    const s = await mount(new Set(['a.ts']), false);
    await s.pointer('onPointerEnter');
    await s.rerender(new Set(['a.ts', 'b.ts']), false);
    await s.rerender(new Set(['a.ts', 'b.ts']), true);
    expect(s.hidden()).toEqual(['a.ts', 'b.ts']);
  });

  test.skipIf(!hasDom)('with Hide viewed off, crossing the panel edge redraws nothing', async () => {
    const viewed = new Set(['a.ts']);
    const s = await mount(viewed, false);
    const before = renders;
    await s.pointer('onPointerEnter');
    await s.pointer('onPointerMove');
    await s.pointer('onPointerLeave');
    expect(renders).toBe(before);
    expect(s.out.current!.hiddenFiles).toBe(viewed);
  });
});
