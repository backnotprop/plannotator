import { useEffect } from 'react';

export interface TreeMemory {
  expanded: string[] | null;
  scrollTop: number;
  activePath?: string | null;
}

export const newTreeMemory = (): TreeMemory => ({ expanded: null, scrollTop: 0 });

interface TreeModel {
  getFileTreeContainer(): HTMLElement | null | undefined;
  getVisibleCount(): number;
  getVisibleRows(start: number, end: number): readonly { kind: string; path: string; isExpanded: boolean }[];
}

const RESTORE_FRAMES = 30;

function expandedFolders(model: TreeModel): string[] {
  const count = model.getVisibleCount();
  if (count === 0) return [];
  return model.getVisibleRows(0, count - 1)
    .filter((row) => row.kind === 'directory' && row.isExpanded)
    .map((row) => row.path);
}

const scrollerOf = (model: TreeModel) =>
  model.getFileTreeContainer()?.shadowRoot?.querySelector<HTMLElement>('[data-file-tree-virtualized-scroll]') ?? null;

export function useTreeMemory(model: TreeModel, memory: TreeMemory | undefined, rememberFolders = false): void {
  useEffect(() => {
    if (!memory) return;
    const target = memory.scrollTop;
    let pending = target > 0;
    let scroller: HTMLElement | null = null;
    let frame = 0;
    const save = () => {
      if (!pending && scroller) memory.scrollTop = scroller.scrollTop;
    };
    const stop = () => { pending = false; };
    const apply = (left: number) => {
      if (!scroller) {
        scroller = scrollerOf(model);
        if (scroller) {
          scroller.addEventListener('scroll', save, { passive: true });
          scroller.addEventListener('touchstart', stop, { passive: true });
          scroller.addEventListener('wheel', stop, { passive: true });
        }
      }
      if (scroller && pending) {
        scroller.scrollTop = target;
        if (scroller.scrollTop >= target - 1) pending = false;
      }
      if ((pending || !scroller) && left > 0 && typeof requestAnimationFrame !== 'undefined') {
        frame = requestAnimationFrame(() => apply(left - 1));
      } else {
        pending = false;
      }
    };
    apply(RESTORE_FRAMES);
    return () => {
      if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frame);
      scroller?.removeEventListener('scroll', save);
      scroller?.removeEventListener('touchstart', stop);
      scroller?.removeEventListener('wheel', stop);
      if (rememberFolders) memory.expanded = expandedFolders(model);
    };
  }, [model, memory, rememberFolders]);
}
