type Resize = (element: Element) => number | undefined;

const LAYOUT_READS = ['clientWidth', 'offsetWidth', 'scrollWidth'] as const;

export interface FakeTextLayout {
  resize: (widthOf: Resize) => void;
  layoutReads: (from?: RegExp) => number;
  restore: () => void;
}

export function installFakeTextLayout(charWidth = 7): FakeTextLayout {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const observers = new Set<{ callback: ResizeObserverCallback; targets: Set<Element>; self: ResizeObserver }>();
  const realObserver = globalThis.ResizeObserver;
  const realGetContext = HTMLCanvasElement.prototype.getContext;
  const realRect = Element.prototype.getBoundingClientRect;
  const realProps = LAYOUT_READS.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
  const reads: string[] = [];
  const read = () => reads.push(new Error().stack ?? '');

  class FakeResizeObserver {
    private entry: { callback: ResizeObserverCallback; targets: Set<Element>; self: ResizeObserver };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set(), self: this as unknown as ResizeObserver };
      observers.add(this.entry);
    }
    observe(target: Element) { this.entry.targets.add(target); }
    unobserve(target: Element) { this.entry.targets.delete(target); }
    disconnect() { this.entry.targets.clear(); }
  }
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

  HTMLCanvasElement.prototype.getContext = function () {
    return {
      font: '',
      measureText: (text: string) => ({ width: Array.from(segmenter.segment(text)).length * charWidth }),
    };
  } as unknown as typeof realGetContext;

  Element.prototype.getBoundingClientRect = function (this: Element) {
    read();
    return realRect.call(this);
  };
  for (const [name, descriptor] of realProps) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        read();
        return descriptor?.get?.call(this) ?? 0;
      },
    });
  }

  return {
    resize(widthOf) {
      for (const { callback, targets, self } of observers) {
        const entries = [...targets].flatMap((target) => {
          const width = widthOf(target);
          return width === undefined ? [] : [{ target, contentRect: { width, height: 16 } } as unknown as ResizeObserverEntry];
        });
        if (entries.length > 0) callback(entries, self);
      }
    },
    layoutReads: (from) => (from ? reads.filter((stack) => from.test(stack)).length : reads.length),
    restore() {
      globalThis.ResizeObserver = realObserver;
      (window as unknown as { ResizeObserver: unknown }).ResizeObserver = realObserver;
      HTMLCanvasElement.prototype.getContext = realGetContext;
      Element.prototype.getBoundingClientRect = realRect;
      for (const [name, descriptor] of realProps) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    },
  };
}
