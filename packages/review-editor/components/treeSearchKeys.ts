import { useEffect, useMemo, useRef } from 'react';

const SEARCH_INPUT = '[data-file-tree-search-input]';

interface SearchableTree {
  getFileTreeContainer(): HTMLElement | undefined | null;
  isSearchOpen(): boolean;
  getSearchValue(): string;
  getItem(path: string): unknown;
  scrollToPath(path: string, options?: { focus?: boolean; offset?: 'nearest' }): void;
}

export function useTreeSearchKeys(model: SearchableTree, openPath: () => string | null = () => null) {
  const steering = useRef(false);
  const menuPress = useRef(false);
  const open = useRef(openPath);
  open.current = openPath;

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
        const at = open.current();
        const drawn = () => (at ? [...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-item-path]') ?? [])].find((r) => r.dataset.itemPath === at) : undefined);
        const row = () => drawn()
          ?? host.shadowRoot?.querySelector<HTMLElement>('[data-type="item"][tabindex="0"]')
          ?? host.shadowRoot?.querySelector<HTMLElement>('[data-type="item"]');
        if (at && !drawn() && model.getItem(at)) {
          model.scrollToPath(at, { focus: true, offset: 'nearest' });
          requestAnimationFrame(() => row()?.focus({ preventScroll: true }));
        } else {
          const target = row();
          if (target) target.focus({ preventScroll: true });
          else (input as HTMLInputElement).blur();
        }
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
