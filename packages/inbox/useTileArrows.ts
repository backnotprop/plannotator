import { useShortcutScope } from '@plannotator/ui/shortcuts';
import { inboxTileShortcuts } from './shortcuts/grid.shortcuts';
import { gridStep, type GridKey } from './gridMove';
import { keyTarget, modalOpen } from './shortcuts/guards';

export function useTileArrows(section: { readonly current: HTMLElement | null }, covered: boolean): void {
  const tileList = (target: Element | null) => (target && section.current?.contains(target) && target.matches('[data-attachment-id]') ? target.closest('.ib-tiles') : null);
  useShortcutScope({
    scope: inboxTileShortcuts,
    handlers: {
      move: {
        when: (event) => {
          if (event.defaultPrevented || event.isComposing || covered || modalOpen()) return false;
          const list = tileList(keyTarget(event));
          return !!list && list.querySelectorAll('[data-attachment-id]').length > 1;
        },
        handle: (event) => {
          const target = keyTarget(event);
          const tiles = [...(tileList(target)?.querySelectorAll<HTMLElement>('[data-attachment-id]') ?? [])];
          const from = tiles.indexOf(target as HTMLElement);
          const to = from < 0 ? null : gridStep(tiles.map((tile) => tile.getBoundingClientRect()), from, event.key as GridKey);
          const next = to === null ? null : tiles[to];
          next?.focus({ preventScroll: true });
          next?.scrollIntoView?.({ block: 'nearest' });
        },
      },
    },
  });
}
