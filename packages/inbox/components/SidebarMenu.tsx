import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  INBOX_SIDEBAR_DEFAULT,
  inboxSidebarHideable,
  inboxSidebarSame,
  inboxSidebarSetShown,
  inboxSidebarShown,
  inboxSidebarSpec,
  type InboxSidebarItem,
  type InboxSidebarLayout,
} from '@plannotator/core/inbox-sidebar';
import { Icon } from '../icons';
import { openSidebarCustomizer, readSidebarLayout, writeSidebarLayout } from '../sidebarLayout';

const TOUCH_WINDOW_MS = 1500;

type Anchor = { getBoundingClientRect: () => DOMRect };

export interface SidebarMenuState {
  open: { anchor: Anchor; opener: HTMLElement | null } | null;
  close: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onTouchStart: () => void;
  portal: HTMLElement | null;
  aside: RefObject<HTMLElement | null>;
}

export function useSidebarMenu(aside: RefObject<HTMLElement | null>, enabled = true): SidebarMenuState {
  const [open, setOpen] = useState<SidebarMenuState['open']>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const touched = useRef(0);
  useLayoutEffect(() => setPortal(aside.current?.closest<HTMLElement>('.pn-inbox') ?? null), [aside]);
  return {
    open,
    portal,
    aside,
    close: () => setOpen(null),
    onTouchStart: () => {
      touched.current = Date.now();
    },
    onContextMenu: (event) => {
      if (!enabled || event.defaultPrevented || Date.now() - touched.current < TOUCH_WINDOW_MS) return;
      event.preventDefault();
      const target = event.target instanceof Element ? event.target : null;
      const control = target?.closest<HTMLElement>('button, a, [tabindex]') ?? null;
      const focused = document.activeElement instanceof HTMLElement && aside.current?.contains(document.activeElement) ? document.activeElement : null;
      const keyboard = event.clientX === 0 && event.clientY === 0;
      const under = keyboard ? (focused ?? control ?? aside.current) : null;
      const rect = under?.getBoundingClientRect();
      const x = rect ? rect.left + 12 : event.clientX;
      const y = rect ? rect.bottom + 2 : event.clientY;
      setOpen({ anchor: { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }, opener: focused ?? control });
    },
  };
}

export function sidebarMenuItems(layout: InboxSidebarLayout, drawn: ReadonlySet<InboxSidebarItem>): InboxSidebarItem[] {
  const order: InboxSidebarItem[] = ['logo', ...layout.top, 'agents', ...layout.bottom, 'shortcuts', 'theme'];
  return order.filter((item) => drawn.has(item) && inboxSidebarHideable(item));
}

export function SidebarMenu({ menu, layout, drawn }: { menu: SidebarMenuState; layout: InboxSidebarLayout; drawn: ReadonlySet<InboxSidebarItem> }) {
  const opener = menu.open?.opener ?? null;
  const items = sidebarMenuItems(layout, drawn);
  const toPanel = useRef(false);
  const focusBack = () => {
    if (toPanel.current) {
      toPanel.current = false;
      return false;
    }
    if (opener?.isConnected) return opener;
    return menu.aside.current?.querySelector<HTMLElement>('[data-inbox-nav]') ?? true;
  };
  return (
    <Menu.Root open={menu.open !== null} onOpenChange={(next) => !next && menu.close()} modal={false}>
      <Menu.Portal container={menu.portal ?? undefined}>
        <Menu.Positioner className="ib-pm-pos" anchor={menu.open?.anchor} side="bottom" align="start" sideOffset={2}>
          <Menu.Popup className="ib-pm ib-side-menu" aria-label="Sidebar" data-sidebar-menu="" finalFocus={focusBack}>
            <Menu.Group>
              <Menu.GroupLabel className="ib-pm-glabel">Show in sidebar</Menu.GroupLabel>
              {items.map((item) => {
                const on = inboxSidebarShown(layout, item);
                return (
                  <Menu.CheckboxItem
                    key={item}
                    className="ib-pmi"
                    checked={on}
                    closeOnClick={false}
                    onCheckedChange={(next: boolean) => void writeSidebarLayout(inboxSidebarSetShown(readSidebarLayout(), item, next))}
                    data-sidebar-toggle={item}
                  >
                    <span className="ib-pmi-box" aria-hidden="true" data-on={on ? '' : undefined}>
                      {on && <Icon name="check" size={11} />}
                    </span>
                    <span className="ib-pmi-l">{inboxSidebarSpec(item).label}</span>
                  </Menu.CheckboxItem>
                );
              })}
            </Menu.Group>
            <Menu.Separator className="ib-pm-sep" />
            <Menu.Item className="ib-pmi" onClick={() => {
                toPanel.current = true;
                openSidebarCustomizer(opener);
              }} data-sidebar-customize="">
              <span className="ib-pmi-l">Customize sidebar…</span>
            </Menu.Item>
            {!inboxSidebarSame(layout, INBOX_SIDEBAR_DEFAULT) && (
              <Menu.Item className="ib-pmi" onClick={() => void writeSidebarLayout(INBOX_SIDEBAR_DEFAULT)} data-sidebar-reset="">
                <span className="ib-pmi-l">Reset to default</span>
              </Menu.Item>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
