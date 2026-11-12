import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationToolbar } from './AnnotationToolbar';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

type Box = { top: number; bottom: number; left: number; right: number };
const rectOf = (box: Box) => ({ ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box }) as DOMRect;

async function mount(first: Box, whole?: () => Box | null) {
  const element = document.createElement('mark');
  element.textContent = 'first words';
  document.body.appendChild(element);
  const place = { first };
  element.getBoundingClientRect = () => rectOf(place.first);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  let closed = 0;
  await act(async () => {
    root?.render(
      <AnnotationToolbar
        element={element}
        positionMode="center-above"
        onAnnotate={() => {}}
        onClose={() => { closed += 1; }}
        onRequestComment={() => {}}
        copyText="first words and many more"
        touchAnchorRect={whole}
        closeOnScrollOut
      />,
    );
  });
  const toolbar = () => document.querySelector<HTMLElement>('.annotation-toolbar');
  const scroll = async (next: Box) => {
    place.first = next;
    await act(async () => { window.dispatchEvent(new Event('scroll')); });
  };
  return { closed: () => closed, toolbar, scroll };
}

const ABOVE: Box = { top: -900, bottom: -880, left: 100, right: 300 };
const ON_SCREEN: Box = { top: 200, bottom: 220, left: 100, right: 300 };

describe.if(hasDom)('AnnotationToolbar closeOnScrollOut', () => {
  test('a selection whose first words are above the window but which reaches into it stays open, on screen', async () => {
    const { closed, toolbar } = await mount(ABOVE, () => ({ top: -900, bottom: 500, left: 100, right: 700 }));

    expect(closed()).toBe(0);
    expect(toolbar()).not.toBeNull();
    expect(parseFloat(toolbar()!.style.top)).toBeGreaterThanOrEqual(8);
  });

  test('it closes once the whole selection is above the window', async () => {
    const whole = { top: 200, bottom: 500, left: 100, right: 700 };
    const { closed, scroll } = await mount(ON_SCREEN, () => whole);
    expect(closed()).toBe(0);

    whole.top = -900;
    whole.bottom = -600;
    await scroll(ABOVE);

    expect(closed()).toBe(1);
  });

  test('and once the whole selection is below it', async () => {
    const whole = { top: 200, bottom: 500, left: 100, right: 700 };
    const { closed, scroll } = await mount(ON_SCREEN, () => whole);

    whole.top = window.innerHeight + 50;
    whole.bottom = window.innerHeight + 350;
    await scroll({ top: window.innerHeight + 50, bottom: window.innerHeight + 70, left: 100, right: 300 });

    expect(closed()).toBe(1);
  });

  test('a host that gives no whole-selection box closes by the first piece, as before', async () => {
    const { closed, scroll } = await mount(ON_SCREEN);
    expect(closed()).toBe(0);

    await scroll(ABOVE);

    expect(closed()).toBe(1);
  });

  test('a selection on screen keeps the toolbar above its first words', async () => {
    const { toolbar } = await mount(ON_SCREEN, () => ({ top: 200, bottom: 260, left: 100, right: 700 }));

    expect(parseFloat(toolbar()!.style.top)).toBe(200 - 48);
  });
});
