export interface DiffLayoutItem {
  id: string;
  top: number;
  height: number;
  collapsed: boolean;
}

export type LineSide = 'old' | 'new';

export interface DiffLayoutSource {
  items(): DiffLayoutItem[] | null;
  contentHeight(): number;
  viewportHeight(): number;
  scrollTop(): number;
  scrollTo(top: number): void;
  revealLine(id: string, line: number, side: LineSide): boolean;
  subscribeScroll(listener: () => void): () => void;
}

export interface CodeViewLike {
  getTopForItem(id: string): number | undefined;
  getScrollHeight(): number;
  getScrollTop(): number;
  getHeight(): number;
  getItem(id: string): { collapsed?: boolean } | undefined;
  subscribeToScroll(listener: (scrollTop: number) => void): () => void;
  scrollTo(target:
    | { type: 'position'; position: number; behavior?: 'instant' }
    | { type: 'line'; id: string; lineNumber: number; side?: 'additions' | 'deletions'; align?: 'center'; behavior?: 'instant' }): void;
}

const CODE_VIEW_METHODS = ['getTopForItem', 'getScrollHeight', 'getScrollTop', 'getHeight', 'getItem', 'subscribeToScroll', 'scrollTo'] as const;

function asCodeView(viewer: unknown): CodeViewLike | null {
  if (viewer == null || typeof viewer !== 'object') return null;
  for (const name of CODE_VIEW_METHODS) {
    if (typeof (viewer as Record<string, unknown>)[name] !== 'function') return null;
  }
  return viewer as CodeViewLike;
}

export function codeViewLayoutSource(getViewer: () => unknown, ids: readonly string[], options: { paddingBottom: number }): DiffLayoutSource {
  const viewer = () => asCodeView(getViewer());
  return {
    items() {
      const v = viewer();
      if (v == null || ids.length === 0) return null;
      const tops: number[] = [];
      for (const id of ids) {
        const top = v.getTopForItem(id);
        if (top == null || !Number.isFinite(top)) return null;
        tops.push(top);
      }
      const end = tops[0] + v.getScrollHeight();
      return ids.map((id, index) => ({
        id,
        top: tops[index],
        height: Math.max(0, (index + 1 < tops.length ? tops[index + 1] : end) - tops[index]),
        collapsed: v.getItem(id)?.collapsed === true,
      }));
    },
    contentHeight() {
      const v = viewer();
      if (v == null || ids.length === 0) return 0;
      return (v.getTopForItem(ids[0]) ?? 0) + v.getScrollHeight() + options.paddingBottom;
    },
    viewportHeight: () => viewer()?.getHeight() ?? 0,
    scrollTop: () => viewer()?.getScrollTop() ?? 0,
    scrollTo(top) {
      viewer()?.scrollTo({ type: 'position', position: Math.max(0, top), behavior: 'instant' });
    },
    revealLine(id, line, side) {
      const v = viewer();
      if (v == null) return false;
      v.scrollTo({ type: 'line', id, lineNumber: line, side: side === 'old' ? 'deletions' : 'additions', align: 'center', behavior: 'instant' });
      return true;
    },
    subscribeScroll(listener) {
      return viewer()?.subscribeToScroll(() => listener()) ?? (() => {});
    },
  };
}

export interface ScrollElementModel {
  ids: readonly string[];
  heightOf(id: string, collapsed: boolean): number;
  isCollapsed(id: string): boolean;
  offsetTop: number;
}

export function scrollElementLayoutSource(getElement: () => HTMLElement | null, model: () => ScrollElementModel | null): DiffLayoutSource {
  return {
    items() {
      const m = model();
      if (m == null) return null;
      let top = m.offsetTop;
      return m.ids.map((id) => {
        const collapsed = m.isCollapsed(id);
        const height = m.heightOf(id, collapsed);
        const item = { id, top, height, collapsed };
        top += height;
        return item;
      });
    },
    contentHeight: () => getElement()?.scrollHeight ?? 0,
    viewportHeight: () => getElement()?.clientHeight ?? 0,
    scrollTop: () => getElement()?.scrollTop ?? 0,
    scrollTo(top) {
      const el = getElement();
      if (el) el.scrollTop = Math.max(0, top);
    },
    revealLine: () => false,
    subscribeScroll(listener) {
      const el = getElement();
      if (!el) return () => {};
      el.addEventListener('scroll', listener, { passive: true });
      return () => el.removeEventListener('scroll', listener);
    },
  };
}

export function withFallback(primary: DiffLayoutSource, fallback: DiffLayoutSource): DiffLayoutSource {
  let usePrimary = true;
  const pick = () => (usePrimary ? primary : fallback);
  return {
    items() {
      const items = primary.items();
      usePrimary = items != null;
      return items ?? fallback.items();
    },
    contentHeight: () => pick().contentHeight() || fallback.contentHeight(),
    viewportHeight: () => pick().viewportHeight() || fallback.viewportHeight(),
    scrollTop: () => pick().scrollTop(),
    scrollTo: (top) => pick().scrollTo(top),
    revealLine: (id, line, side) => pick().revealLine(id, line, side),
    subscribeScroll(listener) {
      const a = primary.subscribeScroll(listener);
      const b = usePrimary ? () => {} : fallback.subscribeScroll(listener);
      return () => {
        a();
        b();
      };
    },
  };
}
