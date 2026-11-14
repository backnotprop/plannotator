import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import DiffMinimap from './DiffMinimap';
import type { DiffLayoutItem, DiffLayoutSource } from './layoutSource';

const STRIP_HEIGHT = 400;
const ADD_LANE_X = 7;

const patch = (name: string) =>
  [`--- a/${name}`, `+++ b/${name}`, '@@ -1,2 +1,6 @@', ' a', '+b', '+c', '+d', '+e', ' f'].join('\n');

const files = ['one.ts', 'two.ts', 'three.ts'].map((path) => ({ id: path, path, patch: patch(path) }));
const metrics = { headerHeight: 32, lineHeight: 20, separatorHeight: 20, paddingBottom: 8 };
const open = 32 + 6 * 20 + 8;

interface Fill {
  x: number;
  y: number;
  h: number;
  alpha: number;
}

let fills: Fill[] = [];
const hasDom = typeof document !== 'undefined';
const restore: Array<() => void> = [];

beforeAll(() => {
  if (!hasDom) return;
  const ElementProto = Object.getPrototypeOf(Object.getPrototypeOf(document.createElement('div'))) as object;
  const proto = Object.getPrototypeOf(document.createElement('canvas')) as { getContext: unknown };
  const realGetContext = proto.getContext;
  proto.getContext = function () {
    const ctx = {
      globalAlpha: 1,
      fillStyle: '',
      setTransform() {},
      clearRect() {
        fills = [];
      },
      fillRect(x: number, y: number, _w: number, h: number) {
        fills.push({ x, y, h, alpha: ctx.globalAlpha });
      },
    };
    return ctx;
  };
  restore.push(() => {
    proto.getContext = realGetContext;
  });
  const height = Object.getOwnPropertyDescriptor(ElementProto, 'clientHeight');
  const width = Object.getOwnPropertyDescriptor(ElementProto, 'clientWidth');
  Object.defineProperty(ElementProto, 'clientHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).hasAttribute('data-diff-minimap-strip') ? STRIP_HEIGHT : 0;
    },
  });
  Object.defineProperty(ElementProto, 'clientWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).hasAttribute('data-diff-minimap-strip') ? 12 : 0;
    },
  });
  restore.push(() => {
    if (height) Object.defineProperty(ElementProto, 'clientHeight', height);
    if (width) Object.defineProperty(ElementProto, 'clientWidth', width);
  });
});

afterAll(() => {
  for (const undo of restore.reverse()) undo();
});

function layoutFor(collapsed: ReadonlySet<string>) {
  let top = 0;
  const items: DiffLayoutItem[] = files.map(({ id }) => {
    const isCollapsed = collapsed.has(id);
    const item = { id, top, height: isCollapsed ? 32 : open, collapsed: isCollapsed };
    top += item.height;
    return item;
  });
  return { items, content: top };
}

function addRuns(): Fill[][] {
  const lane = fills.filter((fill) => fill.x === ADD_LANE_X).sort((a, b) => a.y - b.y);
  const runs: Fill[][] = [];
  for (const fill of lane) {
    const last = runs[runs.length - 1];
    const end = last ? last[last.length - 1].y + last[last.length - 1].h : -1;
    if (last && fill.y <= end) last.push(fill);
    else runs.push([fill]);
  }
  return runs;
}

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
});

describe('diff minimap stays in step with the diff layout', () => {
  test.skipIf(!hasDom)('collapse, expand and viewed redraw the strip from the new layout', async () => {
    let state = layoutFor(new Set());
    const source: DiffLayoutSource = {
      items: () => state.items,
      contentHeight: () => state.content,
      viewportHeight: () => 100,
      scrollTop: () => 0,
      scrollTo() {},
      revealLine: () => false,
      subscribeScroll: () => () => {},
    };
    const pulseRef: { current: (() => void) | null } = { current: null };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (viewed: Set<string>) =>
      act(() => {
        root.render(
          <DiffMinimap source={source} files={files} viewedPaths={viewed} notes={[]} metrics={metrics} labelTop={0} split={false} expandUnchanged={false} pulseRef={pulseRef} />,
        );
      });

    await render(new Set());
    await flush();
    expect(addRuns()).toHaveLength(3);
    const thirdBefore = addRuns()[2][0].y;

    state = layoutFor(new Set(['two.ts']));
    await act(() => pulseRef.current?.());
    await flush();
    const collapsedRuns = addRuns();
    expect(collapsedRuns).toHaveLength(2);
    const k = STRIP_HEIGHT / state.content;
    expect(Math.abs(collapsedRuns[1][0].y - Math.floor((open + 32 + 32 + 20) * k))).toBeLessThanOrEqual(3);
    expect(collapsedRuns[1][0].y).not.toBe(thirdBefore);

    state = layoutFor(new Set());
    await act(() => pulseRef.current?.());
    await flush();
    expect(addRuns()).toHaveLength(3);
    expect(addRuns()[2][0].y).toBe(thirdBefore);

    await render(new Set(['one.ts']));
    await flush();
    const [viewedRun, ...others] = addRuns();
    const peak = (run: Fill[]) => Math.max(...run.map((fill) => fill.alpha));
    for (const run of others) expect(peak(viewedRun)).toBeLessThan(peak(run) * 0.5);

    await act(() => root.unmount());
    host.remove();
  });
});
