import { useEffect, useMemo, useRef } from 'react';

const SEARCH_INPUT = '[data-file-tree-search-input]';

interface SearchableTree {
  getFileTreeContainer(): HTMLElement | undefined | null;
  isSearchOpen(): boolean;
}

export function useTreeSearchKeys(model: SearchableTree) {
  const steering = useRef(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const path = event.composedPath?.() ?? [];
      const host = model.getFileTreeContainer();
      const input = path[0] as Element | undefined;
      if (!host || !path.includes(host) || !input?.matches?.(SEARCH_INPUT)) return;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        steering.current = true;
        queueMicrotask(() => { steering.current = false; });
      } else if (event.key === 'Escape' && !model.isSearchOpen()) {
        event.preventDefault();
        event.stopPropagation();
        (input as HTMLInputElement).blur();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [model]);

  return useMemo(() => ({
    quiet: () => !steering.current && !!model.getFileTreeContainer()?.shadowRoot?.activeElement?.matches(SEARCH_INPUT),
  }), [model]);
}
