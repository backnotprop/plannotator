/**
 * The project rail's right-click menus (PlaceRail.tsx), opened as the sidebar's own is (SidebarMenu.tsx: a pointer's
 * place, or under the focused control from Shift+F10 or the menu key; no new shortcut).
 *
 * - On a pin: Mark all as read (a project's own, as its sidebar row's menu offers it), Move up, Move down, Unpin. On a
 *   Recent place (nothing pinned yet): Pin.
 * - Anywhere else on the rail: "When the sidebar is closed" (Hide it / Keep a rail of places) and Open the sidebar.
 *   Hide it takes the rail away; the pins are kept for next time.
 */
import { useEffect, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { inboxSidebarMovePin, inboxSidebarPin } from '@plannotator/core/inbox-sidebar';
import { Icon } from '../icons';
import { readSidebarLayout, writeSidebarLayout } from '../sidebarLayout';
import { useSidebar } from '../shell/sidebar';
import { RailChoiceItems } from './RailChoice';
import type { RailPlace } from './railModel';
import type { RailHost } from './PlaceRail';

export interface RailMenuAt {
  anchor: { getBoundingClientRect: () => DOMRect };
  /** The pin (or Recent place) right-clicked; null: the rail itself. */
  place: RailPlace | null;
  pinned: boolean;
  opener: HTMLElement | null;
}

export const RAIL_MENU_WORDS = { read: 'Mark all as read', up: 'Move up', down: 'Move down', unpin: 'Unpin', pin: 'Pin', open: 'Open the sidebar' } as const;

export function RailMenus({ at, host, onClose }: { at: RailMenuAt | null; host: RailHost; onClose: () => void }) {
  const { setOpen } = useSidebar();
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(document.querySelector<HTMLElement>('.pn-inbox')), []);
  const place = at?.place ?? null;
  const pins = readSidebarLayout().pins ?? [];
  const index = place ? pins.indexOf(place.key) : -1;
  const write = (next: ReturnType<typeof readSidebarLayout>) => void writeSidebarLayout(next);
  const finalFocus = () => (at?.opener?.isConnected ? at.opener : true);
  return (
    <Menu.Root open={at !== null} onOpenChange={(next) => !next && onClose()} modal={false}>
      <Menu.Portal container={portal ?? undefined}>
        <Menu.Positioner className="ib-pm-pos" anchor={at?.anchor} side="bottom" align="start" sideOffset={2}>
          <Menu.Popup className="ib-pm ib-rail-menu" aria-label={place ? place.label : 'Places'} data-rail-menu={place ? 'place' : 'rail'} finalFocus={finalFocus}>
            {place ? (
              <>
                {place.kind === 'project' && (
                  <>
                    <Menu.Item className="ib-pmi" disabled={!host.readable.has(place.id)} onClick={() => void host.onProjectAction(place.id, 'read')} data-rail-action="read">
                      <Icon name="mailOpen" size={14} />
                      <span className="ib-pmi-l">{RAIL_MENU_WORDS.read}</span>
                    </Menu.Item>
                    <Menu.Separator className="ib-pm-sep" />
                  </>
                )}
                {at?.pinned ? (
                  <>
                    <Menu.Item className="ib-pmi" disabled={index <= 0} onClick={() => write(inboxSidebarMovePin(readSidebarLayout(), place.key, index - 1))} data-rail-action="up">
                      <Icon name="arrowUp" size={14} />
                      <span className="ib-pmi-l">{RAIL_MENU_WORDS.up}</span>
                    </Menu.Item>
                    <Menu.Item className="ib-pmi" disabled={index < 0 || index >= pins.length - 1} onClick={() => write(inboxSidebarMovePin(readSidebarLayout(), place.key, index + 1))} data-rail-action="down">
                      <Icon name="arrowDown" size={14} />
                      <span className="ib-pmi-l">{RAIL_MENU_WORDS.down}</span>
                    </Menu.Item>
                    <Menu.Separator className="ib-pm-sep" />
                    <Menu.Item className="ib-pmi" onClick={() => write(inboxSidebarPin(readSidebarLayout(), place.key, false))} data-rail-action="unpin">
                      <Icon name="pinOff" size={14} />
                      <span className="ib-pmi-l">{RAIL_MENU_WORDS.unpin}</span>
                    </Menu.Item>
                  </>
                ) : (
                  <Menu.Item className="ib-pmi" onClick={() => write(inboxSidebarPin(readSidebarLayout(), place.key, true))} data-rail-action="pin">
                    <Icon name="pin" size={14} />
                    <span className="ib-pmi-l">{RAIL_MENU_WORDS.pin}</span>
                  </Menu.Item>
                )}
              </>
            ) : (
              <>
                <RailChoiceItems closeOnClick />
                <Menu.Separator className="ib-pm-sep" />
                <Menu.Item className="ib-pmi" onClick={() => setOpen(true)} data-rail-action="open">
                  <span className="ib-pmi-l">{RAIL_MENU_WORDS.open}</span>
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
