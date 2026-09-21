import { useEffect, type RefObject } from 'react';

export type CallFlowFindShortcutSurface = 'dock' | 'lens';

/**
 * Gives Cmd/Ctrl+F to exactly one visible Call Flow search surface.
 *
 * Dockview retains inactive panel portals, so mount state is never sufficient
 * proof of ownership. Callers must pass the Dockview active-panel state for a
 * Dock surface or the Popover open state for a Lens surface. An open Lens wins
 * over the Dock because it is the foreground interaction surface.
 */
export function useCallFlowFindShortcut({
  active,
  surface,
  searchOpen,
  inputRef,
  openSearch,
}: {
  readonly active: boolean;
  readonly surface: CallFlowFindShortcutSurface;
  readonly searchOpen: boolean;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly openSearch: () => void;
}): void {
  useEffect(() => {
    if (!active) return;
    const onFind = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey)
        || event.shiftKey
        || event.altKey
        || event.key.toLocaleLowerCase() !== 'f'
      ) return;
      if (document.visibilityState === 'hidden') return;
      if (surface === 'dock' && document.querySelector('[data-call-flow-lens="true"]')) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      if (searchOpen) {
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      openSearch();
    };
    window.addEventListener('keydown', onFind, { capture: true });
    return () => window.removeEventListener('keydown', onFind, { capture: true });
  }, [active, inputRef, openSearch, searchOpen, surface]);
}
