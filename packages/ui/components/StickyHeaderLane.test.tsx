import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScrollViewportProvider } from '../hooks/useScrollViewport';
import type { EditorMode, InputMethod } from '../types';
import {
  StickyHeaderLane,
  type StickyHeaderLaneProps,
  type StickyHeaderLaneVisibility,
} from './StickyHeaderLane';

const hasDom = typeof document !== 'undefined';

class FakeResizeObserver implements ResizeObserver {
  static readonly instances: FakeResizeObserver[] = [];

  private readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }

  emit(target: Element, width: number): void {
    if (!this.observed.has(target)) return;
    const entry: ResizeObserverEntry = {
      target,
      contentRect: new DOMRectReadOnly(0, 0, width, 0),
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    };
    this.callback([entry], this);
  }

  static emitWidth(target: Element, width: number): void {
    for (const observer of FakeResizeObserver.instances) observer.emit(target, width);
  }
}

class FakeIntersectionObserver implements IntersectionObserver {
  static readonly instances: FakeIntersectionObserver[] = [];

  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin: string;
  readonly thresholds: readonly number[];
  private readonly observed = new Set<Element>();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    this.scrollMargin = (
      options as IntersectionObserverInit & { scrollMargin?: string }
    ).scrollMargin ?? '0px';
    this.thresholds = Array.isArray(options.threshold)
      ? options.threshold
      : [options.threshold ?? 0];
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  emit(isIntersecting: boolean): void {
    const rect = new DOMRectReadOnly();
    const entries: IntersectionObserverEntry[] = [...this.observed].map((target) => ({
      target,
      time: 0,
      rootBounds: null,
      boundingClientRect: rect,
      intersectionRect: isIntersecting ? rect : new DOMRectReadOnly(),
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
    }));
    this.callback(entries, this);
  }
}

const originalResizeObserver = globalThis.ResizeObserver;
const originalIntersectionObserver = globalThis.IntersectionObserver;

let root: Root | null = null;
let host: HTMLElement | null = null;
let viewport: HTMLElement | null = null;
let actions: HTMLElement | null = null;

type TestLaneProps = {
  visibility?: StickyHeaderLaneVisibility;
  sticky?: boolean;
  hideQuickLabel?: boolean;
};

function ControlledLane(props: TestLaneProps) {
  const [inputMethod, setInputMethod] = useState<InputMethod>('drag');
  const [mode, setMode] = useState<EditorMode>('selection');

  return (
    <StickyHeaderLane
      inputMethod={inputMethod}
      onInputMethodChange={setInputMethod}
      mode={mode}
      onModeChange={setMode}
      {...props}
    />
  );
}

function laneWrapper(): HTMLElement {
  const element = host?.querySelector<HTMLElement>('[data-sticky-header-lane]');
  if (!element) throw new Error('Expected StickyHeaderLane wrapper to render');
  return element;
}

function laneBar(): HTMLElement {
  const element = laneWrapper().firstElementChild;
  if (!(element instanceof HTMLElement)) throw new Error('Expected StickyHeaderLane bar to render');
  return element;
}

function buttonFor(label: string): HTMLButtonElement | null {
  return Array.from(laneBar().querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.querySelector<HTMLSpanElement>('span:not([aria-hidden])')?.textContent === label,
  ) ?? null;
}

function labelFor(label: string): HTMLSpanElement {
  const element = buttonFor(label)?.querySelector<HTMLSpanElement>('span:not([aria-hidden])');
  if (!element) throw new Error(`Expected ${label} label to render`);
  return element;
}

async function mount(props: TestLaneProps = {}): Promise<void> {
  viewport = document.createElement('div');
  actions = document.createElement('div');
  actions.setAttribute('data-sticky-actions', '');
  host = document.createElement('div');
  document.body.append(viewport, actions, host);
  root = createRoot(host);

  await act(async () => {
    root?.render(
      <ScrollViewportProvider viewport={viewport}>
        <ControlledLane {...props} />
      </ScrollViewportProvider>,
    );
  });
}

function expectNoChrome(element: HTMLElement): void {
  expect(element.classList.contains('bg-card/95')).toBe(false);
  expect(element.classList.contains('backdrop-blur-sm')).toBe(false);
  expect(element.classList.contains('shadow-sm')).toBe(false);
  expect(element.classList.contains('border')).toBe(false);
}

function expectChrome(element: HTMLElement): void {
  expect(element.classList.contains('bg-card/95')).toBe(true);
  expect(element.classList.contains('backdrop-blur-sm')).toBe(true);
  expect(element.classList.contains('shadow-sm')).toBe(true);
  expect(element.classList.contains('border')).toBe(true);
}

beforeEach(() => {
  FakeResizeObserver.instances.length = 0;
  FakeIntersectionObserver.instances.length = 0;
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: FakeResizeObserver,
  });
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: FakeIntersectionObserver,
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host = null;
  viewport = null;
  actions = null;
  if (hasDom) document.body.replaceChildren();
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: originalResizeObserver,
  });
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: originalIntersectionObserver,
  });
});

describe.if(hasDom)('StickyHeaderLane host seams', () => {
  test('default props preserve main resting markup and chrome while hidden', async () => {
    await mount();

    expect(laneWrapper().className).toBe(
      'sticky z-[60] w-full self-center pointer-events-none top-3',
    );
    expect(laneBar().className).toBe(
      'absolute left-3 md:left-5 top-0 inline-flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0 overflow-hidden rounded-lg py-1 md:py-1.5 bg-card/95 backdrop-blur-sm shadow-sm border border-border/30 motion-reduce:transform-none opacity-0 -translate-y-1 pointer-events-none',
    );
    expect(laneBar().hasAttribute('inert')).toBe(true);
    expect(laneBar().style.paddingLeft).toBe('12px');
    expect(laneBar().style.paddingRight).toBe('12px');
    expect(laneBar().style.transition).toBe(
      'opacity 180ms cubic-bezier(0.2, 0, 0, 1), transform 180ms cubic-bezier(0.2, 0, 0, 1)',
    );
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    expectChrome(laneBar());
  });

  test('always is visible and interactive at rest without sticky chrome', async () => {
    await mount({ visibility: 'always', hideQuickLabel: true });

    expect(laneBar().hasAttribute('inert')).toBe(false);
    expect(laneBar().classList.contains('opacity-100')).toBe(true);
    expect(laneBar().classList.contains('pointer-events-auto')).toBe(true);
    expectNoChrome(laneBar());
    expect(buttonFor('Label')).toBeNull();

    const pinpoint = buttonFor('Pinpoint');
    if (!pinpoint) throw new Error('Expected Pinpoint button to render');
    await act(async () => pinpoint.click());
    expect(buttonFor('Pinpoint')?.getAttribute('aria-pressed')).toBe('true');
  });

  test('always adds chrome only for the sticky intersection state', async () => {
    await mount({ visibility: 'always' });
    const observer = FakeIntersectionObserver.instances[0];
    if (!observer) throw new Error('Expected sticky observer to be active');

    await act(async () => observer.emit(false));
    expect(laneBar().classList.contains('opacity-100')).toBe(true);
    expect(laneBar().classList.contains('bg-card/95')).toBe(true);
    expect(laneBar().classList.contains('backdrop-blur-sm')).toBe(true);
    expect(laneBar().classList.contains('shadow-sm')).toBe(true);
    expect(laneBar().classList.contains('border')).toBe(true);

    await act(async () => observer.emit(true));
    expect(laneBar().classList.contains('opacity-100')).toBe(true);
    expect(laneBar().hasAttribute('inert')).toBe(false);
    expectNoChrome(laneBar());
  });

  test('sticky false creates no intersection observer and scrolls in normal flow', async () => {
    await mount({ visibility: 'always', sticky: false });
    if (!actions) throw new Error('Expected Viewer action measurement target');

    await act(async () => {
      FakeResizeObserver.emitWidth(laneWrapper(), 560);
      FakeResizeObserver.emitWidth(actions, 300);
    });

    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    expect(laneWrapper().previousElementSibling).toBeNull();
    expect(laneWrapper().classList.contains('sticky')).toBe(false);
    expect(laneWrapper().classList.contains('relative')).toBe(true);
    expect(laneWrapper().classList.contains('top-[52px]')).toBe(false);
    expect(laneWrapper().classList.contains('md:top-[60px]')).toBe(false);
    expect(laneBar().style.maxWidth).toBe('calc(100% - 24px)');
    expect(laneBar().classList.contains('opacity-100')).toBe(true);
    expectNoChrome(laneBar());
  });

  test('keeps measured wide, tight, and narrow layouts', async () => {
    await mount({ visibility: 'always' });
    if (!actions) throw new Error('Expected Viewer action measurement target');

    await act(async () => {
      FakeResizeObserver.emitWidth(laneWrapper(), 900);
      FakeResizeObserver.emitWidth(actions, 300);
    });
    expect(laneBar().style.maxWidth).toBe('572px');
    expect(labelFor('Markup').style.opacity).toBe('1');
    expect(laneWrapper().classList.contains('top-3')).toBe(true);

    await act(async () => FakeResizeObserver.emitWidth(laneWrapper(), 720));
    expect(laneBar().style.maxWidth).toBe('396px');
    expect(labelFor('Markup').style.opacity).toBe('0');
    expect(laneWrapper().classList.contains('top-3')).toBe(true);

    await act(async () => FakeResizeObserver.emitWidth(laneWrapper(), 560));
    expect(laneBar().style.maxWidth).toBe('calc(100% - 24px)');
    expect(labelFor('Markup').style.opacity).toBe('0');
    expect(laneWrapper().classList.contains('top-[52px]')).toBe(true);
    expect(laneWrapper().classList.contains('md:top-[60px]')).toBe(true);
  });
});
