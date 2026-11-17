import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePanelScrollLock } from './usePanelScrollLock';

const hasDom = typeof document !== 'undefined';
const originalAttribute = hasDom ? document.documentElement.getAttribute('data-pn-panel-scroll-lock') : null;
let root: Root | null = null;
let host: HTMLElement | null = null;

function Lock({ active }: { active: boolean }) {
  usePanelScrollLock(active);
  return null;
}

function Harness({ active = true, second = false }: { active?: boolean; second?: boolean }) {
  return <>
    <Lock active={active} /><Lock active={second} />
    <section data-pn-panel-side="left"><header>Navigate</header>
      <div id="list" style={{ overflowY: 'auto' }}><p>Rows</p></div>
    </section>
    <div role="dialog"><div id="portal-list" style={{ overflowY: 'auto' }}>Other dialog</div></div>
    <main>Document</main>
  </>;
}

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness />));
  for (const list of host.querySelectorAll('#list, #portal-list')) {
    Object.defineProperties(list, { scrollHeight: { value: 500, configurable: true }, clientHeight: { value: 100 } });
  }
}

function touch(target: Element, type: string, x: number, y: number, count = 1) {
  const point = { identifier: 1, clientX: x, clientY: y };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: Array(count).fill(point) },
    changedTouches: { value: [point] },
  });
  target.dispatchEvent(event);
  return event;
}

function drag(target: Element, dy: number, dx = 0) {
  touch(target, 'touchstart', 100, 100);
  return touch(target, 'touchmove', 100 + dx, 100 + dy);
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    if (originalAttribute === null) document.documentElement.removeAttribute('data-pn-panel-scroll-lock');
    else document.documentElement.setAttribute('data-pn-panel-scroll-lock', originalAttribute);
  }
});

describe.if(hasDom)('compact panel native scroll ownership', () => {
  test('native list scrolling works in both directions without changing scrollTop in JavaScript', async () => {
    await mount();
    const list = host!.querySelector<HTMLElement>('#list')!;
    list.scrollTop = 200;
    expect(drag(list, -40).defaultPrevented).toBe(false);
    expect(drag(list, 40).defaultPrevented).toBe(false);
    expect(list.scrollTop).toBe(200);
  });

  test('only the exhausted direction is blocked at a list boundary', async () => {
    await mount();
    const list = host!.querySelector<HTMLElement>('#list')!;
    list.scrollTop = 0;
    expect(drag(list, 40).defaultPrevented).toBe(true);
    expect(drag(list, -40).defaultPrevented).toBe(false);
    list.scrollTop = 400;
    expect(drag(list, -40).defaultPrevented).toBe(true);
    expect(drag(list, 40).defaultPrevented).toBe(false);
  });

  test('headers, short lists and the background cannot hand vertical touches to the document', async () => {
    await mount();
    const list = host!.querySelector('#list')!;
    Object.defineProperty(list, 'scrollHeight', { value: 100 });
    for (const target of [list, host!.querySelector('header')!, host!.querySelector('main')!]) {
      expect(drag(target, -40).defaultPrevented).toBe(true);
      expect(drag(target, 40).defaultPrevented).toBe(true);
    }
  });

  test('horizontal swipes, pinch zoom and a nested dialog keep their interaction', async () => {
    await mount();
    const header = host!.querySelector('header')!;
    expect(drag(header, 2, 60).defaultPrevented).toBe(false);
    touch(header, 'touchstart', 100, 100);
    expect(touch(header, 'touchmove', 100, 160, 2).defaultPrevented).toBe(false);
    const portalList = host!.querySelector('#portal-list')!;
    expect(drag(portalList, -40).defaultPrevented).toBe(false);
  });

  test('releasing the panel restores document gestures and retains preexisting attributes', async () => {
    document.documentElement.setAttribute('data-pn-panel-scroll-lock', 'previous');
    await mount();
    expect(document.documentElement.getAttribute('data-pn-panel-scroll-lock')).toBe('true');
    await act(async () => root?.render(<Harness active={false} />));
    expect(document.documentElement.getAttribute('data-pn-panel-scroll-lock')).toBe('previous');
    expect(drag(host!.querySelector('header')!, -40).defaultPrevented).toBe(false);
  });

  test('one closing owner does not unlock another open panel', async () => {
    await mount();
    await act(async () => root?.render(<Harness second />));
    await act(async () => root?.render(<Harness active={false} second />));
    expect(document.documentElement.getAttribute('data-pn-panel-scroll-lock')).toBe('true');
    expect(drag(host!.querySelector('header')!, -40).defaultPrevented).toBe(true);
    await act(async () => root?.render(<Harness active={false} />));
    expect(document.documentElement.getAttribute('data-pn-panel-scroll-lock')).toBe(originalAttribute);
  });
});
