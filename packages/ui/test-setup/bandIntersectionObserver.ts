/**
 * A geometric IntersectionObserver for DOM tests (happy-dom has none and lays
 * nothing out): it reads `getBoundingClientRect()` of the root and of each
 * target, applies the `rootMargin` (px or % of the root's height, top and
 * bottom), and reports the targets whose intersection changed, at once on
 * `observe` and on every `scroll` of the root, as a real observer reports
 * crossings. Enough to drive `useActiveSection` (plan review's scroll-spy)
 * at given scroll positions.
 */

type Side = { value: number; percent: boolean };

function parseMargin(margin: string | undefined): [Side, Side] {
  const parts = (margin ?? '0px').trim().split(/\s+/);
  const side = (raw: string | undefined): Side => ({
    value: Number.parseFloat(raw ?? '0') || 0,
    percent: (raw ?? '').endsWith('%'),
  });
  const top = side(parts[0]);
  const bottom = side(parts[2] ?? parts[0]);
  return [top, bottom];
}

class BandIntersectionObserver {
  private readonly targets = new Map<Element, boolean>();
  private readonly root: Element | null;
  private readonly margins: [Side, Side];

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = (options.root as Element | null | undefined) ?? null;
    this.margins = parseMargin(options.rootMargin);
    this.root?.addEventListener('scroll', this.check);
  }

  observe(target: Element) {
    this.targets.set(target, false);
    this.check(true);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
    this.root?.removeEventListener('scroll', this.check);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  private readonly check = (initial: unknown = false) => {
    const area = this.root?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const [top, bottom] = this.margins;
    const px = (side: Side) => (side.percent ? (area.height * side.value) / 100 : side.value);
    const bandTop = area.top - px(top);
    const bandBottom = area.bottom + px(bottom);
    const entries: IntersectionObserverEntry[] = [];
    for (const [target, was] of this.targets) {
      const rect = target.getBoundingClientRect();
      const now = bandBottom >= bandTop && rect.bottom >= bandTop && rect.top <= bandBottom;
      if (now === was && initial !== true) continue;
      this.targets.set(target, now);
      entries.push({ target, isIntersecting: now, boundingClientRect: rect } as unknown as IntersectionObserverEntry);
    }
    if (entries.length > 0) this.callback(entries, this as unknown as IntersectionObserver);
  };
}

/** Install the band observer as `globalThis.IntersectionObserver`; returns the restore. */
export function installBandIntersectionObserver(): () => void {
  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = BandIntersectionObserver as unknown as typeof IntersectionObserver;
  return () => {
    globalThis.IntersectionObserver = original;
  };
}
