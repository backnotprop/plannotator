/**
 * The sidebar's right-click menu (approval "inbox-sidebar-customize", 2026-11-08): a plain checkbox for each item
 * that can hide ("Show in sidebar"), then "Customize sidebar…" (the panel, where items move), then "Reset to
 * default" while the layout is not the default. Nothing moves from here (the owner: moving lives only in the panel).
 *
 * It opens on a right-click anywhere in the sidebar a row of its own does not claim (a project's and a starred
 * thread's menus stay theirs), and from the keyboard on the platform's own keys (Shift+F10, the menu key) on a
 * focused sidebar control: no new shortcut. A touch never opens it, as no Inbox menu opens on a touch; on a phone
 * the way in is Settings → General → Sidebar. Ticking leaves the menu open, so several items change in one go; the
 * sidebar changes at once behind it. Escape, Tab or a pick puts focus back where it was, or on Inbox when that row
 * just hid.
 */
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

/** A touch (or a long press a phone turns into `contextmenu`) never opens the menu. */
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

/** The trigger side: the sidebar's `contextmenu` and where the menu opens. `enabled: false` (the tour's sidebar): no menu. */
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
      // A project's or a starred thread's own menu took it; a touch; the tour.
      if (!enabled || event.defaultPrevented || Date.now() - touched.current < TOUCH_WINDOW_MS) return;
      event.preventDefault();
      const target = event.target instanceof Element ? event.target : null;
      const control = target?.closest<HTMLElement>('button, a, [tabindex]') ?? null;
      const focused = document.activeElement instanceof HTMLElement && aside.current?.contains(document.activeElement) ? document.activeElement : null;
      // From the keyboard (Shift+F10, the menu key) there is no pointer: the menu opens under the focused control.
      const keyboard = event.clientX === 0 && event.clientY === 0;
      const under = keyboard ? (focused ?? control ?? aside.current) : null;
      const rect = under?.getBoundingClientRect();
      const x = rect ? rect.left + 12 : event.clientX;
      const y = rect ? rect.bottom + 2 : event.clientY;
      setOpen({ anchor: { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }, opener: focused ?? control });
    },
  };
}

/** The items the menu offers, as the sidebar reads top to bottom: the logo, the top stack, the bottom stack, the Settings row's buttons. */
export function sidebarMenuItems(layout: InboxSidebarLayout, drawn: ReadonlySet<InboxSidebarItem>): InboxSidebarItem[] {
  const order: InboxSidebarItem[] = ['logo', ...layout.top, ...layout.bottom, 'shortcuts', 'theme'];
  return order.filter((item) => drawn.has(item) && inboxSidebarHideable(item));
}

export function SidebarMenu({ menu, layout, drawn }: { menu: SidebarMenuState; layout: InboxSidebarLayout; drawn: ReadonlySet<InboxSidebarItem> }) {
  const opener = menu.open?.opener ?? null;
  const items = sidebarMenuItems(layout, drawn);
  // "Customize sidebar…" hands focus to the panel's title: the menu's close puts it nowhere.
  const toPanel = useRef(false);
  const focusBack = () => {
    if (toPanel.current) {
      toPanel.current = false;
      return false;
    }
    if (opener?.isConnected) return opener;
    // The row it was opened from just hid: Inbox, which never hides.
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
