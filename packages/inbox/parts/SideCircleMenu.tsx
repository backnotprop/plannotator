import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import { Icon } from '../icons';
import { useContextMenuTrigger } from '../components/useContextMenuTrigger';

/** The one item the menu aims at: the circle (there is one per window). */
const ID = 'side-circle';

export interface SideCircleMenuProps {
  /** The circle, the button a right-click, a long press or the menu key opens this on. */
  button: () => HTMLElement | null;
  /** The circle as drawn (its 28 px disc): the menu sits just above it, right edges aligned, whatever opened it. */
  anchor: () => HTMLElement | null;
  /** Close: the circle goes for this thread, the conversation stays (data/sideCircleClosed.ts). */
  onClose: () => void;
  /** The menu is open: the circle's tooltip stays shut under it. */
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

/**
 * The minimized side chat's own menu (the owner, 2026-11-21: "how about a right-click on the circle and close?"): a
 * right-click on the circle, a finger held on it (LONG_PRESS_MS), or the context-menu key or Shift+F10 on it opens
 * the Inbox's menu (`.ib-pm`) with one item, Close. The trigger's rules are the thread rows' (useContextMenuTrigger,
 * `longPress`): a right-click is never a click, the lift after a long press opens nothing, and a tap is a tap. No
 * shortcut of its own. The trigger draws no box (`display: contents`), so the circle keeps its place and hit area.
 * The menu is anchored to the circle, not to the pointer (a right-click's menu would cover the circle it belongs to):
 * above it, its right edge on the circle's, the dropdowns' 4 px gap, for a right-click, a long press and a key alike.
 */
export function SideCircleMenu({ button, anchor, onClose, onOpenChange, children }: SideCircleMenuProps) {
  const body = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(body.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const menu = useContextMenuTrigger({
    itemOf: (target) => (target instanceof Element ? target.closest<HTMLElement>('[data-side-chat-corner]') : null),
    idOf: () => ID,
    has: () => true,
    buttonFor: () => button(),
    // Close takes the circle away: the caller puts focus where it belongs (menu.keepFocus below).
    slotOf: () => ({ order: [], fallback: () => null }),
    stateOf: () => '',
    onTarget: () => {},
    longPress: true,
  });
  const open = menu.open;
  useLayoutEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  return (
    <ContextMenu.Root {...menu.root}>
      <ContextMenu.Trigger ref={body} className="ib-sc-trig" {...menu.trigger}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal container={portal ?? undefined}>
        <ContextMenu.Positioner className="ib-pm-pos" anchor={anchor} side="top" align="end" sideOffset={4}>
          <ContextMenu.Popup className="ib-pm" aria-label="Side chat" data-side-circle-menu="" {...menu.popup}>
            <Menu.Item
              className="ib-pmi"
              label="Close"
              data-side-circle-close=""
              onClick={() => {
                menu.keepFocus();
                menu.close();
                onClose();
              }}
            >
              <Icon name="x" size={15} />
              Close
            </Menu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
