import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScrollViewportProvider } from '../hooks/useScrollViewport';
import type { Block, EditorMode, InputMethod } from '../types';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
// SAFETY: The suite is skipped without a DOM; every executed test therefore
// has the real module loaded before it renders Viewer.
const Viewer = viewerModule?.Viewer as typeof import('./Viewer')['Viewer'];

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
    this.callback([{
      target,
      contentRect: new DOMRectReadOnly(0, 0, width, 0),
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    }], this);
  }

  static emitWidth(target: Element, width: number): void {
    for (const observer of FakeResizeObserver.instances) observer.emit(target, width);
  }
}

class FakeIntersectionObserver implements IntersectionObserver {
  static readonly instances: FakeIntersectionObserver[] = [];
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin = '0px';
  readonly thresholds: readonly number[];
  private readonly observed = new Set<Element>();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
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

  get observedCount(): number {
    return this.observed.size;
  }

  emit(isIntersecting: boolean): void {
    const rect = new DOMRectReadOnly();
    this.callback([...this.observed].map((target) => ({
      target,
      time: 0,
      rootBounds: null,
      boundingClientRect: rect,
      intersectionRect: isIntersecting ? rect : new DOMRectReadOnly(),
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
    })), this);
  }
}

const originalResizeObserver = globalThis.ResizeObserver;
const originalIntersectionObserver = globalThis.IntersectionObserver;

const blocks: Block[] = [
  { id: 'heading', type: 'heading', content: 'Document title', level: 1, order: 0, startLine: 1 },
];

let root: Root | null = null;
let host: HTMLElement | null = null;
let viewport: HTMLElement | null = null;

function ControlledViewer({ sticky = true }: { readonly sticky?: boolean }) {
  const [inputMethod, setInputMethod] = useState<InputMethod>('drag');
  const [mode, setMode] = useState<EditorMode>('selection');

  return (
    <Viewer
      blocks={blocks}
      markdown="# Document title"
      annotations={[]}
      onAddAnnotation={() => {}}
      onSelectAnnotation={() => {}}
      selectedAnnotationId={null}
      mode={mode}
      inputMethod={inputMethod}
      taterMode={false}
      stickyActions={sticky}
      disableCodePathValidation
      repoInfo={{ display: 'backnotprop/plannotator', branch: 'main' }}
      annotationHeader={{
        onInputMethodChange: setInputMethod,
        onModeChange: setMode,
        hideQuickLabel: true,
      }}
    />
  );
}

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  viewport = document.createElement('div');
  document.body.append(viewport, host);
  root = createRoot(host);
  await render(ui);
}

async function render(ui: React.ReactElement): Promise<void> {
  await act(async () => {
    root?.render(
      <ScrollViewportProvider viewport={viewport}>
        {ui}
      </ScrollViewportProvider>,
    );
  });
}

function header(): HTMLElement {
  const element = host?.querySelector<HTMLElement>('[data-viewer-document-header]');
  if (!element) throw new Error('Expected Viewer document header');
  return element;
}

function actions(): HTMLElement {
  const element = header().querySelector<HTMLElement>('[data-sticky-actions]');
  if (!element) throw new Error('Expected Viewer document actions');
  return element;
}

function buttonFor(label: string): HTMLButtonElement | null {
  return Array.from(header().querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.querySelector<HTMLSpanElement>('span:not([aria-hidden])')?.textContent === label,
  ) ?? null;
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
  if (hasDom) document.body.replaceChildren();
  window.history.replaceState(null, '', window.location.pathname);
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

describe.if(hasDom)('Viewer annotationHeader', () => {
  test('keeps the legacy action bar unchanged when the opt-in prop is absent', async () => {
    await mount(
      <Viewer
        blocks={blocks}
        markdown="# Document title"
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
      />,
    );

    expect(host?.querySelector('[data-viewer-document-header]')).toBeNull();
    const legacyActions = host?.querySelector<HTMLElement>('[data-sticky-actions]');
    expect(legacyActions?.classList.contains('float-right')).toBe(true);
    expect(legacyActions?.classList.contains('mt-6')).toBe(true);
  });

  test('owns one in-flow, printable-safe header and preserves operative controls', async () => {
    await mount(<ControlledViewer />);

    const sharedHeader = header();
    expect(sharedHeader.hasAttribute('data-print-hide')).toBe(true);
    expect(sharedHeader.classList.contains('absolute')).toBe(false);
    expect(sharedHeader.classList.contains('mb-3')).toBe(true);
    expect(sharedHeader.querySelector('[data-viewer-annotation-controls]')).not.toBeNull();
    expect(actions().querySelector('button[title="Add global comment"]')).not.toBeNull();
    expect(actions().querySelector('button[title="Copy plan"]')).not.toBeNull();
    expect(sharedHeader.textContent).toContain('backnotprop/plannotator');
    expect(buttonFor('Label')).toBeNull();
    expect(sharedHeader.textContent).not.toContain('How does this work?');

    const pinpoint = buttonFor('Pinpoint');
    if (!pinpoint) throw new Error('Expected Pinpoint control');
    await act(async () => pinpoint.click());
    expect(buttonFor('Pinpoint')?.getAttribute('aria-pressed')).toBe('true');

    const globalComment = actions().querySelector<HTMLButtonElement>('button[title="Add global comment"]');
    if (!globalComment) throw new Error('Expected global comment action');
    await act(async () => globalComment.click());
    expect(document.querySelector('textarea')).not.toBeNull();
  });

  test('measures wide, tight, and narrow wrapped layouts without overlay clearance', async () => {
    await mount(<ControlledViewer />);

    await act(async () => {
      FakeResizeObserver.emitWidth(header(), 900);
      FakeResizeObserver.emitWidth(actions(), 300);
    });
    expect(header().dataset.headerLayout).toBe('wide');
    expect(buttonFor('Markup')?.querySelector<HTMLElement>('span:not([aria-hidden])')?.style.opacity).toBe('1');

    await act(async () => FakeResizeObserver.emitWidth(header(), 720));
    expect(header().dataset.headerLayout).toBe('tight');
    expect(buttonFor('Markup')?.querySelector<HTMLElement>('span:not([aria-hidden])')?.style.opacity).toBe('0');

    await act(async () => FakeResizeObserver.emitWidth(header(), 560));
    expect(header().dataset.headerLayout).toBe('narrow');
    expect(header().firstElementChild?.classList.contains('flex-col')).toBe(true);
    expect(actions().classList.contains('self-end')).toBe(true);
  });

  test('pins the combined header and adds chrome only after crossing the sentinel', async () => {
    await mount(<ControlledViewer />);
    expect(header().classList.contains('sticky')).toBe(true);
    expect(header().classList.contains('top-3')).toBe(true);
    expect(header().classList.contains('bg-card/95')).toBe(false);
    expect(FakeIntersectionObserver.instances).toHaveLength(1);

    const observer = FakeIntersectionObserver.instances[0];
    if (!observer) throw new Error('Expected sticky intersection observer');
    await act(async () => observer.emit(false));
    expect(header().classList.contains('bg-card/95')).toBe(true);
    expect(header().classList.contains('backdrop-blur-sm')).toBe(true);
    expect(header().classList.contains('shadow-sm')).toBe(true);

    await act(async () => observer.emit(true));
    expect(header().classList.contains('bg-card/95')).toBe(false);
  });

  test('scrolls the same combined header in flow when stickiness is disabled', async () => {
    await mount(<ControlledViewer sticky={false} />);
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    expect(header().classList.contains('relative')).toBe(true);
    expect(header().classList.contains('sticky')).toBe(false);
    expect(header().classList.contains('top-3')).toBe(false);
    expect(header().previousElementSibling).toBeNull();
  });

  test('reattaches sticky observation when the header branch changes at runtime', async () => {
    await mount(<ControlledViewer />);
    const firstObserver = FakeIntersectionObserver.instances[0];
    expect(firstObserver?.observedCount).toBe(1);

    await render(
      <Viewer
        blocks={blocks}
        markdown="# Document title"
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        stickyActions
        disableCodePathValidation
      />,
    );

    expect(host?.querySelector('[data-viewer-document-header]')).toBeNull();
    expect(firstObserver?.observedCount).toBe(0);
    expect(FakeIntersectionObserver.instances).toHaveLength(2);
    expect(FakeIntersectionObserver.instances[1]?.observedCount).toBe(1);
  });

  test('does not reserve a non-sticky header when navigating to an anchor', async () => {
    await mount(<ControlledViewer sticky={false} />);
    const target = document.getElementById('document-title');
    if (!target || !viewport) throw new Error('Expected heading and scroll viewport');

    Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: 100 });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    target.getBoundingClientRect = () => new DOMRect(0, 300, 400, 40);
    header().getBoundingClientRect = () => new DOMRect(0, 0, 800, 80);
    let requestedTop: number | undefined;
    viewport.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
      requestedTop = typeof options === 'number' ? y : options?.top;
    };

    window.history.replaceState(null, '', '#document-title');
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await act(async () => Bun.sleep(5));

    expect(requestedTop).toBe(400);
  });
});
