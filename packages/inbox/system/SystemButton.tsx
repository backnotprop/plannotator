/**
 * The System button in the Reviews header (approval "system-inbox", screens 3 and 2a), beside the filter mark: its
 * menu lists the projects that have a drawing, each with its sheet count, and "Set up a project" at the foot (the
 * setup dialog, `openSystemSetup`). A project opens its drawing in the Reviews pane; the list is never filtered by it
 * (Reviews with no filters, variant B). While a project is open the button names it, filled as the filter's picked
 * rows are. Shown only while System shows (`systemShown`). Base UI carries the keys; no shortcut of its own.
 */
import { useEffect, useState, type RefObject } from 'react';
import { Menu } from '@base-ui/react/menu';
import { systemListed, type SystemProjectRow } from '@plannotator/core/inbox-system';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { openSystemSetup } from './opener';
import { systemStateWords } from './projects';

export interface SystemButtonProps {
  /** The projects with their drawing's state; null until read. */
  projects: SystemProjectRow[] | null;
  /** The project whose drawing is open in the pane, or null. */
  open: string | null;
  phone: boolean;
  /** Where the menu is drawn (the window's root, so its theme reaches it). */
  portalRef: RefObject<HTMLElement | null>;
  onOpen: (project: string) => void;
  /** The menu opened: the projects are read again. */
  onMenu?: () => void;
}

export function SystemButton({ projects, open, phone, portalRef, onOpen, onMenu }: SystemButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(portalRef.current?.closest<HTMLElement>('.pn-inbox') ?? null), [portalRef]);
  const listed = (projects ?? []).filter(systemListed);
  const current = open ? (projects?.find((p) => p.id === open) ?? null) : null;
  return (
    <Menu.Root
      open={menuOpen}
      onOpenChange={(next) => {
        setMenuOpen(next);
        if (next) onMenu?.();
      }}
      modal={phone}
    >
      <Menu.Trigger className="ib-sysb" aria-label={current ? `System: ${current.name}` : 'System'} data-set={current ? '' : undefined} data-system-button="">
        {current ? (
          <span className="ib-sysb-in">
            <Icon name="diagram" />
            <span className="ib-sysb-n" dir="auto">
              {current.name}
            </span>
          </span>
        ) : (
          // Drawn anew when the menu opens or closes, so a tooltip never stays over the open menu.
          <Tip key={menuOpen ? 'menu' : 'rest'} content="System">
            <span className="ib-sysb-in">
              <Icon name="diagram" />
            </span>
          </Tip>
        )}
      </Menu.Trigger>
      <Menu.Portal container={portal ?? undefined}>
        {phone && <Menu.Backdrop className="ib-pm-scrim" />}
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={6} data-phone={phone ? '' : undefined}>
          <Menu.Popup className="ib-pm ib-pc-menu ib-sysm" aria-label="System" data-system-menu="">
            <div className="ib-sysm-h">System</div>
            {projects !== null && listed.length === 0 && (
              <p className="ib-sysm-none" data-system-menu-none="">
                No project is drawn yet.
              </p>
            )}
            {listed.length > 0 && (
              <Menu.RadioGroup value={open ?? ''} onValueChange={(next: string) => next && onOpen(next)}>
                {listed.map((p) => (
                  <Menu.RadioItem key={p.id} value={p.id} closeOnClick className="ib-pmi" label={p.name} data-system-menu-project={p.id}>
                    <Icon name="book" />
                    <span className="ib-pmi-l" dir="auto">
                      {p.name}
                    </span>
                    <span className="ib-pmi-n">{systemStateWords(p)}</span>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            )}
            <Menu.Separator className="ib-pm-sep" />
            <Menu.Item className="ib-pmi" onClick={() => openSystemSetup()} data-system-menu-setup="">
              <Icon name="plus" />
              <span className="ib-pmi-l">Set up a project</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
