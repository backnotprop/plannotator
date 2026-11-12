import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import { INBOX_PROJECT_NAME_MAX } from '@plannotator/core/inbox-types';
import type { ProjectFolder } from '../api';
import { formatCount } from '../format';
import { Icon } from '../icons';
import { projectNameMatches } from '../projectCombine';
import type { LabeledProject } from '../projectLabels';
import type { ProjectAction } from '../projectMenu';
import { ProjectTipText, Tip } from './Tip';
import { ProjectMark, showsProjects, useRowMarks } from '../letterMarks';
import { hasSetPicture, useKnownProjects } from '../projectPictures';

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
  /** Says a line in the window's live region (the field's refusals: an empty or too long name). */
  announce?: (text: string) => void;
  /** This machine's other projects: a typed name that is one of theirs asks to combine (`projectNameMatches`). */
  others?: readonly LabeledProject[];
  /** The warning's Combine: this project goes into `into`. Resolves true once the list shows it. Absent: no warning. */
  onCombine?: (into: LabeledProject) => Promise<boolean>;
  /**
   * Set picture… (this machine's projects, only while Settings → Rows shows project marks): an image as a data: URL,
   * or null to take the picture away. Resolves true once the list has it. Absent: not offered.
   */
  onPicture?: (file: File | null) => Promise<boolean>;
  /**
   * "+" beside ⋯ (approval "launch-create-clone", F1-F7): opens New message with a new session in this project. `tip`
   * is its tip and name ("New session in billing-svc", with the machine, and "starts when it's back" while asleep).
   * Absent: no "+" (launch is off, or a guest's page).
   */
  newSession?: { tip: string; onPress: () => void };
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
 * "+" (`newSession`) sits beside ⋯ and shows with it (hover, keyboard focus, the menu open; a phone draws no "+",
 * only ⋯): a new session in this project, with no new key (Tab reaches it, Enter or Space presses it).
 *
 * Rename… (after a separator) turns the row into a field holding its name:
 * Enter saves, Escape or leaving the field cancels, and an empty name is not
 * saved. Reset name, offered only once a name is set, goes back to the
 * folder's name. Focus goes back to ⋯ after Enter, Escape or Reset name; a
 * click elsewhere keeps focus where it landed.
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
  // A computer only: a phone's rows show ⋯ alone (the owner, 2026-11-10: "not necessary right now").
  const newSession = props.phone ? undefined : props.newSession;
  const onRename = props.onRename;
  // Letter marks (letterMarks.tsx): the project's mark before its name, while Settings → Rows shows project marks.
  const { marks } = useRowMarks();
  const projectMarks = showsProjects(marks.what);
  useKnownProjects();
  const row = (children: ReactNode, extra: Record<string, unknown> = {}) => (
    <div
      className="ib-projrow"
      data-project={project.id}
      data-plus={newSession ? '' : undefined}
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
      named={typeof project.display_name === 'string' && project.display_name !== ''}
      picture={projectMarks && props.onPicture ? (hasSetPicture(project.id) ? 'set' : 'none') : null}
      onAction={(action) => {
        setMenuOpen(false);
        setContextOpen(false);
        if (action === 'picture') {
          const onPicture = props.onPicture;
          if (onPicture) pickPicture((file) => void onPicture(file));
          return;
        }
        if (action === 'unpicture') {
          void props.onPicture?.(null);
          return;
        }
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
  /** The field closes. `refocus`: after Enter or Escape, ⋯ takes focus; after a click elsewhere, focus stays there. */
  const doneRenaming = (refocus: boolean) => {
    toField.current = false;
    backToMore.current = refocus;
    setRenaming(false);
  };
  if (renaming && onRename) {
    return row(
      <ProjectNameField
        name={project.name}
        folder={folderName(project.root)}
        announce={props.announce}
        others={props.others ?? []}
        onCombine={
          props.onCombine &&
          (async (into) => {
            const done = await props.onCombine!(into);
            if (done) doneRenaming(true);
            return done;
          })
        }
        onCancel={doneRenaming}
        onSave={async (name) => {
          const saved = await onRename(name);
          if (saved) doneRenaming(true);
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
          {projectMarks && <ProjectMark projectId={project.id} name={project.name} size={marks.style === 'avatar' ? 20 : 16} solid={marks.style === 'avatar'} className="ib-lm-side" />}
          <span className="ib-name" dir="auto">{project.name}</span>
          {/* On the list it shows, the row refreshes it (click Inbox to refresh): ↻ on hover, one turn on a click. */}
          {(props.refreshes || props.refreshSpin != null) && (
            <Icon key={props.refreshSpin ?? 'rest'} name="refresh" size={14} className="ib-ic-refresh" />
          )}
          {props.count > 0 && <span className="ib-n">{formatCount(props.count)}</span>}
        </button>
      </ProjectTip>
      {newSession && (
        <Tip content={newSession.tip}>
          <button type="button" className="ib-pplus" aria-label={newSession.tip} onClick={newSession.onPress} data-pplus={project.id}>
            <Icon name="plus" size={16} />
          </button>
        </Tip>
      )}
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
type ProjectMenuAction = ProjectAction | 'rename' | 'reset' | 'picture' | 'unpicture';

/**
 * The items, no descriptions: the two batches, then (this machine's projects) Rename… and, once a name is
 * set, Reset name. The phone's sheet draws its title (the project) above them.
 */
function ProjectMenuItems(props: {
  name: string;
  readable: boolean;
  rename: boolean;
  named: boolean;
  /** Set picture… is offered (null: not; "set": a picture is set, so it can also be taken away). */
  picture: 'none' | 'set' | null;
  onAction: (action: ProjectMenuAction) => void;
}) {
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
      {/* Only while project marks show (Settings → Rows), so it is not there by default. */}
      {props.picture && (
        <>
          <Menu.Separator className="ib-pm-sep" />
          <Menu.Item className="ib-pmi" label="Set picture…" onClick={() => onAction('picture')} data-project-action="picture">
            <Icon name="photo" size={15} />
            Set picture…
          </Menu.Item>
          {props.picture === 'set' && (
            <Menu.Item className="ib-pmi" label="Remove picture" onClick={() => onAction('unpicture')} data-project-action="unpicture">
              <Icon name="replay" size={15} />
              Remove picture
            </Menu.Item>
          )}
        </>
      )}
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
 * it selected. Enter saves (an empty or too long name is refused, said in the window's live region; the
 * same name just closes); Escape cancels. Leaving the field cancels too, and focus stays where the person
 * went (the reply box, search); leaving the window (switching apps) keeps the field. While the save is on its
 * way the field stays, read only; a refused save leaves it open (the window's toast says why). The cap
 * counts characters (code points) as the server does, so an emoji name is not cut at half.
 *
 * A typed name that is another project's asks instead of making two projects with one name
 * (approval "project-combine"): one line under the field, Cancel and Combine, no Keep both. Enter combines and
 * Escape cancels. A name several projects answer to ("acme", two clones) offers one button for each, and
 * Enter leaves the choice to the person.
 *
 * An agent's sidebar row uses it too (agents/AgentsSection.tsx): `label` names the field, nothing combines, and
 * `emptyResets` saves an empty name as "" instead of refusing it.
 */
export function ProjectNameField(props: {
  name: string;
  folder: string;
  announce?: (text: string) => void;
  others: readonly LabeledProject[];
  onCombine?: (into: LabeledProject) => Promise<boolean>;
  onSave: (name: string) => Promise<boolean>;
  onCancel: (refocus: boolean) => void;
  /** The field's spoken name; "Project name" when absent. */
  label?: string;
  /** An empty name is saved (as "") rather than refused. */
  emptyResets?: boolean;
}) {
  const [value, setValue] = useState(props.name);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Enter or Escape closed the field: a blur as it goes is not "leaving the field".
  const closing = useRef(false);
  const hint = useId();
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    field.select();
  }, []);
  const typed = value.replace(/\s+/g, ' ').trim();
  const matches = props.onCombine && typed !== '' && typed !== props.name ? projectNameMatches(typed, props.others) : [];
  const warning =
    matches.length === 0
      ? null
      : matches.length === 1
        ? `${matches[0]!.name} already exists. Enter combines them, Escape cancels.`
        : `${typed} matches ${formatCount(matches.length)} projects. Pick one to combine with, or press Escape to cancel.`;
  useEffect(() => {
    if (warning) props.announce?.(warning);
  }, [warning]);
  const refuse = (why: string) => {
    setRefused(why);
    props.announce?.(why);
  };
  const close = (refocus: boolean) => {
    closing.current = true;
    props.onCancel(refocus);
  };
  const combine = async (into: LabeledProject) => {
    setBusy(true);
    closing.current = true;
    if (!(await props.onCombine?.(into))) {
      closing.current = false;
      setBusy(false);
      input.current?.focus();
    }
  };
  const save = async () => {
    if (typed === '' && !props.emptyResets) return refuse('A name cannot be empty.');
    if ([...typed].length > INBOX_PROJECT_NAME_MAX) return refuse(`A name can be at most ${INBOX_PROJECT_NAME_MAX} characters.`);
    if (typed === props.name) return close(true);
    if (matches.length === 1) return combine(matches[0]!);
    if (warning) return props.announce?.(warning);
    setBusy(true);
    closing.current = true;
    if (!(await props.onSave(typed))) {
      closing.current = false;
      setBusy(false);
      input.current?.focus();
    }
  };
  /** Keeps the field's focus: a press on Cancel or Combine is not "leaving the field". */
  const stayFocused = (event: MouseEvent) => event.preventDefault();
  return (
    <div
      ref={box}
      onBlur={(event) => {
        // Tab from the field to its buttons stays; anywhere else is leaving.
        if (box.current?.contains(event.relatedTarget as Node | null)) return;
        // The window lost focus (another app): the field is still here when the person comes back.
        if (busy || closing.current || !document.hasFocus()) return;
        close(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // The field's own Escape: nothing above it (the phone's sheet, the list) takes this press.
        event.preventDefault();
        event.stopPropagation();
        if (!busy) close(true);
      }}
    >
      <input
        ref={input}
        type="text"
        className="ib-proj-rename"
        aria-label={props.label ?? 'Project name'}
        aria-describedby={hint}
        aria-invalid={refused ? true : undefined}
        placeholder={props.folder}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="none"
        enterKeyHint="done"
        dir="auto"
        value={value}
        readOnly={busy}
        onChange={(event) => {
          setRefused(null);
          setValue(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!busy) void save();
          }
        }}
        data-project-name-field=""
      />
      {matches.length > 0 && (
        <div className="ib-proj-clash" data-project-clash={matches.map((match) => match.id).join(' ')}>
          <span>
            {matches.length === 1 ? (
              <>
                <b dir="auto">{matches[0]!.name}</b> already exists. Combine them?
              </>
            ) : (
              <>
                <b dir="auto">{typed}</b> matches {formatCount(matches.length)} projects. Combine with one?
              </>
            )}
          </span>
          <button type="button" className="ib-btn ib-sm" disabled={busy} onMouseDown={stayFocused} onClick={() => close(true)} data-project-combine-cancel="">
            Cancel
          </button>
          {matches.length === 1 ? (
            <button type="button" className="ib-btn ib-pri ib-sm" disabled={busy} onMouseDown={stayFocused} onClick={() => void combine(matches[0]!)} data-project-combine={matches[0]!.id}>
              Combine
            </button>
          ) : (
            matches.map((match) => (
              <button key={match.id} type="button" className="ib-btn ib-sm" disabled={busy} onMouseDown={stayFocused} onClick={() => void combine(match)} data-project-combine={match.id}>
                <span className="ib-name" dir="auto">
                  {match.name}
                </span>
              </button>
            ))
          )}
        </div>
      )}
      <span id={hint} hidden>
        {refused ? `${refused} ` : ''}
        {warning ?? 'Enter to save, Escape to cancel.'}
      </span>
    </div>
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

/** Set picture…: the system's file picker, for one image (read by `pictureFromFile`). Nothing picked: nothing happens. */
function pickPicture(onPicked: (file: File) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) onPicked(file);
  };
  input.click();
}
