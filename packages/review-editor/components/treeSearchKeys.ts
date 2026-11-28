import { useEffect, useMemo, useRef } from 'react';

const SEARCH_INPUT = '[data-file-tree-search-input]';

interface SearchableTree {
  getFileTreeContainer(): HTMLElement | undefined | null;
  isSearchOpen(): boolean;
  getSearchValue(): string;
}

export function useTreeSearchKeys(model: SearchableTree) {
  const steering = useRef(false);
  const menuPress = useRef(false);

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
        const row = host.shadowRoot?.querySelector<HTMLElement>('[data-type="item"][tabindex="0"]')
          ?? host.shadowRoot?.querySelector<HTMLElement>('[data-type="item"]');
        if (row) row.focus({ preventScroll: true });
        else (input as HTMLInputElement).blur();
      }
    };
    const onPress = (event: PointerEvent) => {
      if (event.button === 0 && !event.ctrlKey) return;
      menuPress.current = true;
      setTimeout(() => { menuPress.current = false; }, 0);
    };
    const onClick = (event: MouseEvent) => {
      const host = model.getFileTreeContainer();
      const path = event.composedPath?.() ?? [];
      if (!host || !path.includes(host) || model.getSearchValue() !== '') return;
      const input = host.shadowRoot?.activeElement;
      const row = path.find((node): node is HTMLElement => node instanceof HTMLElement && node.dataset.type === 'item');
      if (row && input?.matches(SEARCH_INPUT)) row.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPress, true);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('click', onClick);
    };
  }, [model]);

  return useMemo(() => ({
    quiet: () => menuPress.current || (!steering.current && !!model.getFileTreeContainer()?.shadowRoot?.activeElement?.matches(SEARCH_INPUT)),
  }), [model]);
}
