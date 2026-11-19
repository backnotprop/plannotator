/**
 * A chart against a real DOM (happy-dom): what is mounted for one. Its words are text put there by React,
 * never markup, so a title that looks like an element is a title; a reader of the page is told what the
 * chart shows, from its rows; and nothing in it moves.
 *
 * happy-dom lays nothing out, so the view is given a size here: nothing is mounted in a view with no width.
 *
 * Requires DOM: listed in tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanvasStore } from '../events/store';
import { createDocument } from '../model/document';
import type { CanvasObject } from '../model/types';
import { CameraController } from '../view/camera';
import { CanvasEditor } from './CanvasEditor';
import { CanvasView } from './CanvasView';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
const saved: Record<string, PropertyDescriptor | undefined> = {};

beforeAll(() => {
  if (!hasDom) return;
  for (const [name, value] of [['clientWidth', 800], ['clientHeight', 600]] as const) {
    saved[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
});

afterAll(() => {
  if (!hasDom) return;
  for (const name of Object.keys(saved)) {
    if (saved[name]) Object.defineProperty(HTMLElement.prototype, name, saved[name]!);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

const HOSTILE = '<img src=x onerror="document.title=1"><script>document.title=2</script>';
const CHART = {
  id: 'ch', type: 'chart', x: 40, y: 40, w: 380, h: 240, mark: 'line', title: HOSTILE, unit: 'min',
  fields: ['week', 'minutes'], rows: [[HOSTILE.slice(0, 60), 11.2], ['W2', 4.1], ['W3', 1.3]], encode: { x: 'week', y: 'minutes' },
  rules: [{ at: 5, label: '<b>target</b>' }],
};

async function mount(editor: boolean, extra: object = {}): Promise<{ host: HTMLElement; store: CanvasStore }> {
  const store = new CanvasStore(createDocument('board', 'Board'));
  const added = store.dispatch({ type: 'add', objects: [{ ...CHART, ...extra } as unknown as CanvasObject] }, { actor: { kind: 'agent', id: 'a' } });
  if (!added.ok) throw new Error(added.error);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(editor ? <CanvasEditor store={store} /> : <CanvasView store={store} camera={new CameraController()} />);
  });
  return { host, store };
}

describe.skipIf(!hasDom)('a chart, mounted', () => {
  test('its words are text: a title that looks like markup makes no element and runs nothing', async () => {
    const title = document.title;
    const { host } = await mount(false);
    const chart = host.querySelector('[data-id="ch"]')!;
    expect(chart.querySelector('svg.pcv-chart-svg')).not.toBeNull();
    expect(chart.querySelectorAll('img, script, b, foreignObject, iframe, a').length).toBe(0);
    // Only the two kinds of shape the drawing makes.
    expect([...chart.querySelectorAll('svg *')].map((el) => el.tagName.toLowerCase()).filter((tag) => tag !== 'path' && tag !== 'text')).toEqual([]);
    expect([...chart.querySelectorAll('text')].some((el) => el.textContent === '<b>target</b>')).toBe(true);
    expect(document.title).toBe(title);
  });

  test('in a figure it is one picture, named from its rows; its inside is not read out twice', async () => {
    const { host } = await mount(false, { title: 'Scan to alert' });
    const chart = host.querySelector('[data-id="ch"]')!;
    expect(chart.getAttribute('role')).toBe('img');
    expect(chart.getAttribute('aria-label')).toContain('Scan to alert. Line chart of minutes from 11.2 to 1.3 min by week: 3 rows');
    expect(chart.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  test('in an editor it can be reached and says what it is', async () => {
    const { host } = await mount(true, { title: 'Scan to alert' });
    const chart = host.querySelector('[data-id="ch"]')!;
    expect(chart.getAttribute('aria-label')).toContain('Chart: Scan to alert. Line chart of minutes');
    expect(chart.getAttribute('tabindex')).not.toBeNull();
  });

  test('a change to its rows redraws it; a move does not work it out again', async () => {
    const { host, store } = await mount(false, { title: 'Scan to alert' });
    const line = () => host!.querySelector('[data-id="ch"] path.pcv-ch-s-accent')!;
    const before = line().getAttribute('d');
    await act(async () => {
      store.dispatch({ type: 'move', ids: ['ch'], dx: 30, dy: 10 });
    });
    expect(line().getAttribute('d')).toBe(before);
    await act(async () => {
      store.dispatch({ type: 'edit', id: 'ch', patch: { rows: [['W1', 1], ['W2', 9], ['W3', 30]] } });
    });
    expect(line().getAttribute('d')).not.toBe(before);
    expect([...host.querySelectorAll('[data-id="ch"] text')].some((el) => el.textContent === '30')).toBe(true);
    await act(async () => {
      store.undo();
    });
    expect(line().getAttribute('d')).toBe(before);
  });
});
