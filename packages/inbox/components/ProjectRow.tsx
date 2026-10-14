import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { ProjectFolder } from '../api';
import { formatCount } from '../format';
import { Icon } from '../icons';
import type { ProjectAction } from '../projectMenu';

export interface ProjectRowProps {
  project: ProjectFolder;
  /** Rows waiting on the person (Stopped, Holding, Waiting): the count. */
  count: number;
  /** The list shows this project. */
  on: boolean;
  /** Shown only because the list shows it (nothing of it is listed): dimmed until the person leaves. */
  held: boolean;
  /** Something in the project waits on the person: Mark all as read has work to do. */
  readable: boolean;
  /** A phone: ⋯ always shown, the menu a sheet from the bottom edge, no right-click. */
  phone: boolean;
  onOpen: () => void;
  onAction: (action: ProjectAction) => void;
}

/**
 * One project in the sidebar, with its menu (design record
 * "inbox-project-menu", approved 2026-10-14): the row opens the project, and
 * ⋯ beside it (two buttons side by side, never one inside the other, as the
 * Settings row) opens "Mark all as read" and "Archive all". On the desktop ⋯
 * shows on hover, on keyboard focus and while the menu is open, in place of
 * the count, and a right-click on the row opens the same menu at the
 * pointer. On a phone ⋯ is always shown and the menu is a sheet titled by
 * the project. Base UI's Menu and ContextMenu carry the keys (arrows,
 * Home/End, type-ahead, Escape and Tab close, focus back to ⋯). No new
 * shortcut: the platform's context-menu key reaches the row by itself.
 */
export function ProjectRow(props: ProjectRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  // The menu is drawn inside the window's root, so the window's styles (and theme) reach it.
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(more.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const { project } = props;
  const items = (
    <ProjectMenuItems
      name={project.name}
      readable={props.readable}
      onAction={(action) => {
        setMenuOpen(false);
        setContextOpen(false);
        props.onAction(action);
      }}
    />
  );
  const row = (children: ReactNode, extra: Record<string, unknown> = {}) => (
    <div
      className="ib-projrow"
      data-project={project.id}
      data-menu={menuOpen || contextOpen ? '' : undefined}
      data-held={props.held ? '' : undefined}
      {...extra}
    >
      {children}
    </div>
  );
  const content = (
    <>
      <button
        type="button"
        className={`ib-proj${props.count === 0 ? ' ib-proj-quiet' : ''}${props.on ? ' ib-on' : ''}`}
        onClick={props.onOpen}
        aria-current={props.on ? 'page' : undefined}
        title={project.root}
      >
        <span className="ib-name" dir="auto">{project.name}</span>
        {props.count > 0 && <span className="ib-n">{formatCount(props.count)}</span>}
      </button>
      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <Menu.Trigger ref={more} className="ib-pmore" aria-label={`${project.name} options`} data-pmore={project.id}>
          <Icon name="dots" size={16} />
        </Menu.Trigger>
        <Menu.Portal container={portal ?? undefined}>
          {props.phone && <Menu.Backdrop className="ib-pm-scrim" />}
          <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4} data-phone={props.phone ? '' : undefined}>
            <Menu.Popup className="ib-pm" aria-label={project.name} data-project-menu={project.id}>
              {items}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </>
  );
  if (props.phone) return row(content);
  return (
    <ContextMenu.Root onOpenChange={setContextOpen}>
      <ContextMenu.Trigger render={row(content)} />
      <ContextMenu.Portal container={portal ?? undefined}>
        <ContextMenu.Positioner className="ib-pm-pos">
          {/* Focus goes back to the row's ⋯, never the page. */}
          <ContextMenu.Popup className="ib-pm" aria-label={project.name} data-project-menu={project.id} finalFocus={more}>
            {items}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The two items, no descriptions. The phone's sheet draws its title (the project) above them. */
function ProjectMenuItems({ name, readable, onAction }: { name: string; readable: boolean; onAction: (action: ProjectAction) => void }) {
  return (
    <>
      {/* The popup is named by the project already (aria-label): the title is for the eye only. */}
      <div className="ib-pm-title" dir="auto" aria-hidden="true">
        {name}
      </div>
      <Menu.Item className="ib-pmi" label="Mark all as read" disabled={!readable} onClick={() => onAction('read')} data-project-action="read">
        <Icon name="checkCircle" size={15} />
        Mark all as read
      </Menu.Item>
      <Menu.Item className="ib-pmi" label="Archive all" onClick={() => onAction('archive')} data-project-action="archive">
        <Icon name="archive" size={15} />
        Archive all
      </Menu.Item>
    </>
  );
}
