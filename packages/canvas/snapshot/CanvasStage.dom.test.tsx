/**
 * The stage against a real DOM (happy-dom): opening a figure and coming
 * back leaves the plan exactly where it was.
 *
 * happy-dom lays nothing out, so the figure has no box and the stage takes
 * its no-travel path (the one reduced motion takes). What is guarded here
 * does not depend on the motion: the plan is never unmounted or scrolled,
 * the page behind is inert only while the canvas is open, focus goes in and
 * comes back, Escape leaves, and nothing is left behind (no timer, no style
 * on the plan).
 *
 * Requires DOM: listed in tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanvasStore } from '../events/store';
import { createDocument } from '../model/document';
import { CanvasStage } from './CanvasStage';
import { CanvasRegistry } from './registry';
import { SnapshotFigure, type SnapshotOpenRequest } from './SnapshotFigure';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

function board(): { store: CanvasStore; registry: CanvasRegistry } {
  const store = new CanvasStore(createDocument('board', 'Board'));
  store.dispatch({ type: 'add', objects: [{ id: 'a', type: 'box', x: 0, y: 0, w: 100, h: 40, text: 'A' }, { id: 'b', type: 'note', x: 200, y: 0, w: 100, h: 40, text: 'B' }] });
  store.dispatch({ type: 'add-snapshot', snapshot: { id: 'both', title: 'Both', source: { kind: 'objects', objects: ['a', 'b'] } } });
  const registry = new CanvasRegistry();
  registry.set('board', store);
  return { store, registry };
}

const closedCalls: number[] = [];

function Page({ registry }: { registry: CanvasRegistry }) {
  const [request, setRequest] = useState<SnapshotOpenRequest | null>(null);
  return (
    <>
      <div id="plan" style={{ height: 300, overflowY: 'auto' }}>
        <p style={{ height: 800 }}>Above</p>
        <SnapshotFigure canvas="board" snapshot="both" registry={registry} onOpen={setRequest} />
        <p style={{ height: 800 }}>Below</p>
      </div>
      <CanvasStage
        request={request}
        registry={registry}
        recede={() => document.getElementById('plan')}
        onClosed={() => {
          closedCalls.push(1);
          setRequest(null);
        }}
      />
    </>
  );
}

async function mount(registry: CanvasRegistry): Promise<HTMLElement> {
  host = document.createElement('div');
  host.id = 'app';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Page registry={registry} />);
  });
  return document.getElementById('plan')!;
}

const settle = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

describe('opening a figure and coming back', () => {
  test.skipIf(!hasDom)('the plan is where it was: same element, same scroll offset, nothing left on it', async () => {
    const { registry } = board();
    const plan = await mount(registry);
    plan.scrollTop = 640;
    closedCalls.length = 0;
    const open = plan.querySelector<HTMLButtonElement>('.pcv-figure-hit')!;
    open.focus();

    await act(async () => open.click());
    const stage = document.querySelector<HTMLElement>('.pcv-stage')!;
    expect(stage).not.toBeNull();
    // The plan is still there, untouched, and out of reach behind the open canvas.
    expect(document.getElementById('plan')).toBe(plan);
    expect(plan.scrollTop).toBe(640);
    expect(host!.inert).toBe(true);
    expect(stage.inert).toBe(false);
    expect((document.activeElement as HTMLElement).textContent).toContain('Back to plan');

    await act(async () => [...stage.querySelectorAll('button')].find((button) => button.textContent?.includes('Back to plan'))!.click());
    await settle(200);
    expect(document.querySelector('.pcv-stage')).toBeNull();
    expect(closedCalls).toHaveLength(1);
    expect(document.getElementById('plan')).toBe(plan);
    expect(plan.scrollTop).toBe(640);
    expect(host!.inert).toBe(false);
    expect(plan.style.transform).toBe('');
    expect(plan.style.filter).toBe('');
    expect(plan.style.opacity).toBe('');
    expect(document.activeElement).toBe(open);
  });

  test.skipIf(!hasDom)('Escape leaves the canvas, and leaving twice is still one return', async () => {
    const { registry } = board();
    const plan = await mount(registry);
    plan.scrollTop = 120;
    closedCalls.length = 0;
    await act(async () => plan.querySelector<HTMLButtonElement>('.pcv-figure-hit')!.click());
    const stage = document.querySelector<HTMLElement>('.pcv-stage')!;
    const escape = () => stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await act(async () => {
      escape();
      escape();
    });
    await settle(200);
    expect(document.querySelector('.pcv-stage')).toBeNull();
    expect(closedCalls).toHaveLength(1);
    expect(plan.scrollTop).toBe(120);
    expect(host!.inert).toBe(false);
  });

  test.skipIf(!hasDom)('a canvas torn down while it is closing calls back to nobody and leaves the page in reach', async () => {
    const { registry } = board();
    const plan = await mount(registry);
    closedCalls.length = 0;
    await act(async () => plan.querySelector<HTMLButtonElement>('.pcv-figure-hit')!.click());
    const stage = document.querySelector<HTMLElement>('.pcv-stage')!;
    await act(async () => stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    // Gone before its fade has finished.
    act(() => root!.unmount());
    root = null;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closedCalls).toHaveLength(0);
    expect(host!.inert).toBe(false);
  });
});
