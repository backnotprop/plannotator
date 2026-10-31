import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import { INBOX_PROJECT_NAME_MAX } from '@plannotator/core/inbox-types';
import type { ProjectFolder } from '../api';
import { formatCount } from '../format';
import { Icon } from '../icons';
import type { ProjectAction } from '../projectMenu';
import { ProjectTipText, Tip } from './Tip';

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
  /** The list shows this project, no thread open: pressing the row refreshes it (↻ on hover, "Refresh"). */
  refreshes?: boolean;
  /** A refresh of this project just ran: its ↻ turns once (the key restarts the turn). */
  refreshSpin?: number | null;
  /**
   * Rename… and Reset name (this machine's projects only): a name, or null to go back to the folder's
   * name. Resolves true once the new name is in the list. Absent: neither item is offered.
   */
  onRename?: (name: string | null) => Promise<boolean>;
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
 *
 * Rename… (after a separator) turns the row into a field holding its name:
 * Enter saves, Escape or leaving the field cancels, and an empty name is not
 * saved. Reset name, offered only once a name is set, goes back to the
 * folder's name. Focus goes back to ⋯ after either.
 */
export function ProjectRow(props: ProjectRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  // Rename… was picked: the closing menu leaves focus alone (the field takes it) instead of giving it to ⋯.
  const toField = useRef(false);
  // The field closed: ⋯ takes focus once it is drawn again, never the page.
  const backToMore = useRef(false);
  // The menu is drawn inside the window's root, so the window's styles (and theme) reach it.
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(more.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  useEffect(() => {
    if (renaming || !backToMore.current) return;
    backToMore.current = false;
    more.current?.focus();
  }, [renaming]);
  const { project } = props;
  const onRename = props.onRename;
  const row = (children: ReactNode, extra: Record<string, unknown> = {}) => (
    <div
      className="ib-projrow"
      data-project={project.id}
      data-menu={menuOpen || contextOpen ? '' : undefined}
      data-held={props.held ? '' : undefined}
      data-renaming={renaming ? '' : undefined}
      {...extra}
    >
      {children}
    </div>
  );
  const items = (
    <ProjectMenuItems
      name={project.name}
      readable={props.readable}
      rename={onRename !== undefined}
      named={Boolean(project.display_name)}
      onAction={(action) => {
        setMenuOpen(false);
        setContextOpen(false);
        if (action === 'rename') {
          toField.current = true;
          setRenaming(true);
          return;
        }
        if (action === 'reset') {
          void onRename?.(null);
          return;
        }
        props.onAction(action);
      }}
    />
  );
  const doneRenaming = () => {
    toField.current = false;
    backToMore.current = true;
    setRenaming(false);
  };
  if (renaming && onRename) {
    return row(
      <ProjectNameField
        name={project.name}
        folder={folderName(project.root)}
        onCancel={doneRenaming}
        onSave={async (name) => {
          const saved = await onRename(name);
          if (saved) doneRenaming();
          return saved;
        }}
      />,
    );
  }
  const content = (
    <>
      <ProjectTip name={project.name} root={project.root} refresh={props.refreshes === true}>
        <button
          type="button"
          className={`ib-proj${props.count === 0 ? ' ib-proj-quiet' : ''}${props.on ? ' ib-on' : ''}`}
          onClick={props.onOpen}
          aria-current={props.on ? 'page' : undefined}
          data-refreshes={props.refreshes ? '' : undefined}
          data-refreshing={props.refreshSpin != null ? '' : undefined}
        >
          <span className="ib-name" dir="auto">{project.name}</span>
          {/* On the list it shows, the row refreshes it (click Inbox to refresh): ↻ on hover, one turn on a click. */}
          {(props.refreshes || props.refreshSpin != null) && (
            <Icon key={props.refreshSpin ?? 'rest'} name="refresh" size={14} className="ib-ic-refresh" />
          )}
          {props.count > 0 && <span className="ib-n">{formatCount(props.count)}</span>}
        </button>
      </ProjectTip>
      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <Menu.Trigger ref={more} className="ib-pmore" aria-label={`${project.name} options`} data-pmore={project.id}>
          <Icon name="dots" size={16} />
        </Menu.Trigger>
        <Menu.Portal container={portal ?? undefined}>
          {props.phone && <Menu.Backdrop className="ib-pm-scrim" />}
          <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4} data-phone={props.phone ? '' : undefined}>
            <Menu.Popup className="ib-pm" aria-label={project.name} data-project-menu={project.id} finalFocus={() => !toField.current}>
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
          {/* Focus goes back to the row's ⋯, never the page (the field takes it after Rename…). */}
          <ContextMenu.Popup className="ib-pm" aria-label={project.name} data-project-menu={project.id} finalFocus={() => (toField.current ? false : more.current)}>
            {items}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The menu's own items beside the batches: Rename… and Reset name stay in the row. */
type ProjectMenuAction = ProjectAction | 'rename' | 'reset';

/**
 * The items, no descriptions: the two batches, then (this machine's projects) Rename… and, once a name is
 * set, Reset name. The phone's sheet draws its title (the project) above them.
 */
function ProjectMenuItems(props: { name: string; readable: boolean; rename: boolean; named: boolean; onAction: (action: ProjectMenuAction) => void }) {
  const { name, readable, onAction } = props;
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
      {props.rename && (
        <>
          <Menu.Separator className="ib-pm-sep" />
          <Menu.Item className="ib-pmi" label="Rename…" onClick={() => onAction('rename')} data-project-action="rename">
            <Icon name="pen" size={15} />
            Rename…
          </Menu.Item>
          {props.named && (
            <Menu.Item className="ib-pmi" label="Reset name" onClick={() => onAction('reset')} data-project-action="reset">
              <Icon name="replay" size={15} />
              Reset name
            </Menu.Item>
          )}
        </>
      )}
    </>
  );
}

/** A folder path's last part: what Reset name goes back to (the field's placeholder). */
function folderName(root: string): string {
  const parts = root.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

/**
 * The row's name as a field (Rename…), in the row's own place and size. It opens holding the name, all of
 * it selected. Enter saves (an empty name is not sent, the same name just closes); Escape or leaving the
 * field cancels. While the save is on its way the field stays, read only; a refused save leaves it open
 * (the window's toast says why).
 */
function ProjectNameField(props: { name: string; folder: string; onSave: (name: string) => Promise<boolean>; onCancel: () => void }) {
  const [value, setValue] = useState(props.name);
  const [busy, setBusy] = useState(false);
  const [empty, setEmpty] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const hint = useId();
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    field.select();
  }, []);
  const save = async () => {
    const name = value.replace(/\s+/g, ' ').trim();
    if (name === '') {
      setEmpty(true);
      return;
    }
    if (name === props.name) {
      props.onCancel();
      return;
    }
    setBusy(true);
    if (!(await props.onSave(name))) {
      setBusy(false);
      input.current?.focus();
    }
  };
  return (
    <>
      <input
        ref={input}
        type="text"
        className="ib-proj-rename"
        aria-label="Project name"
        aria-describedby={hint}
        aria-invalid={empty ? true : undefined}
        placeholder={props.folder}
        maxLength={INBOX_PROJECT_NAME_MAX}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="none"
        enterKeyHint="done"
        dir="auto"
        value={value}
        readOnly={busy}
        onChange={(event) => {
          setEmpty(false);
          setValue(event.target.value);
        }}
        onBlur={() => {
          if (!busy) props.onCancel();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!busy) void save();
          } else if (event.key === 'Escape') {
            // The field's own Escape: nothing above it (the phone's sheet, the list) takes this press.
            event.preventDefault();
            event.stopPropagation();
            if (!busy) props.onCancel();
          }
        }}
        data-project-name-field=""
      />
      <span id={hint} hidden>
        {empty ? 'A name cannot be empty. ' : ''}Enter to save, Escape to cancel.
      </span>
    </>
  );
}

/**
 * A sidebar project's tooltip, on hover or keyboard focus: its whole name
 * (the row cuts a long one) over the folder it is, which the row never
 * shows. Always opens, since the folder is never on screen. A screen reader
 * hears the folder as the row's description (visually hidden text named by
 * `aria-describedby`), as it did from the native title.
 */
export function ProjectTip({ name, root, refresh = false, children }: { name: string; root: string; refresh?: boolean; children: ReactElement }) {
  const describedBy = useId();
  return (
    <>
      {/* The project the list shows says what a press does, like Inbox; its folder is in the list's header and the description. */}
      <Tip side="right" content={refresh ? 'Refresh' : <ProjectTipText name={name} root={root} />}>
        {cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': describedBy })}
      </Tip>
      {/* `hidden`: not read a second time in browse mode; aria-describedby still reads it. */}
      <span id={describedBy} hidden data-project-folder="">
        {root}
      </span>
    </>
  );
}
