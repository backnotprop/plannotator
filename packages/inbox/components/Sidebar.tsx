import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { InboxHealth, InboxListRow, InboxRestartAgents } from '@plannotator/core/inbox-types';
import { inboxRowSnoozed } from '@plannotator/core/inbox-snooze';
import { restartAgentsDescription, restartAgentsLabel, restartAgentsOf } from '../restartAgents';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { ClaudeIcon, CodexIcon, OpenCodeIcon, PiIcon } from '@plannotator/ui/components/icons/AgentIcons';
import type { ProjectFolder } from '../api';
import { connectPrompt } from '../connectPrompt';
import { formatCount } from '../format';
import { Icon, type IconName } from '../icons';
import { pinnedState } from '../pins';
import { starPopping } from '../starPop';
import { awayLine, isAway, type MachinesModel } from '../machines';
import { useSidebarSections, type SidebarSection } from '../sidebarSections';
import { useSidebar } from '../shell/sidebar';
import { usePhone } from '../phone';
import { shortProjectNames } from '../projectLabels';
import { shownProjects, type ProjectAction } from '../projectMenu';
import { projectSortControl, setProjectSort, sortProjects, useProjectSort, type ProjectSort } from '../projectSort';
import { selfMachineId } from '../inboxUrl';
import { ProjectRow } from './ProjectRow';
import { newSessionTip } from '../compose/model';
import { PinnedRow, type PinnedAction } from './PinnedRow';
import { useInboxTheme } from '../theme';
import { TaterMark } from './TaterMark';
import { ProjectTip } from './ProjectRow';
import { Tip } from './Tip';
import { CheckFailingRow, UpdateButton } from './Updates';
import { UsageRow } from './Usage';
import type { UpdateCheckFailing } from '../api';
import { inboxSearchShortcuts } from '../search/searchShortcut';
import { ShortcutHint, useShortcutAria, withShortcut } from '../shortcuts/hint';
import { inboxAppShortcuts } from '../shortcuts/app.shortcuts';
import { Pebble } from '@plannotator/ui/components/shape/Pebble';

export interface SidebarProps {
  page: 'inbox' | 'settings' | 'whats-new' | 'drafts' | 'board' | 'reviews' | 'shapes' | 'artifacts';
  /**
   * Artifacts (approval "inbox-artifact-stars"): the row in the top group, always shown with `onArtifacts`, that opens
   * the Artifacts wall on All. No count.
   */
  onArtifacts?: () => void;
  /**
   * The Board (approval "inbox-board", step 2): the row under Inbox, always
   * shown with `onBoard`. No count: the approval keeps the count in the
   * Board's header ("N in flight · N on you").
   */
  onBoard?: () => void;
  /**
   * Reviews (approvals "inbox-code-review-direction", item 4, and "inbox-reviews-page"): a row of its own (after Board when the Board is on; it needs none), shown only with
   * `onPulls` (Settings → Capabilities → Code review on). `pullsCount`: the last read's "On you".
   */
  onPulls?: () => void;
  pullsCount?: number;
  /**
   * Shape (approval "shape-inbox-placement"): the row directly under Board (under Inbox with the Board off),
   * given only while Shape is on and there are 3 or more boards. `shapeChanged`: the boards changed since you looked.
   */
  onShape?: () => void;
  shapeChanged?: number;
  projectId: string | null;
  /** The machine the list shows (the Machines filter), or null for every machine. */
  machineId?: string | null;
  /**
   * Linked machines (machines.ts): the Machines section above Projects, this machine first, each a filter of the
   * list as a project is. No machine linked: no section at all.
   */
  machines?: MachinesModel;
  /** Rows waiting on the person, per machine id. */
  machineCounts?: ReadonlyMap<string, number>;
  onMachine?: (machineId: string) => void;
  /** Rows waiting on the person, all projects. */
  inboxCount: number;
  projects: readonly ProjectFolder[];
  /**
   * The window's name for each project (`windowProjectNames`, App.tsx), shared with the rows so a project reads
   * the same in both, the pins' tooltip and name too. Absent, or a project not in it: the server's name.
   */
  projectNames?: ReadonlyMap<string, string>;
  /** Rows waiting on the person, per project id. */
  projectCounts: ReadonlyMap<string, number>;
  /** Each project's latest activity (`projectActivity`): what "most recent" sorts Projects by. */
  projectActivity?: ReadonlyMap<string, string>;
  /**
   * The project menu (design record "inbox-project-menu"): the projects where
   * Mark all as read has something to do, and the action. Absent: no menu.
   */
  projectsReadable?: ReadonlySet<string>;
  onProjectAction?: (projectId: string, action: ProjectAction) => void;
  /**
   * The project menu's Rename… and Reset name: a name, or null for the folder's name. Offered on this
   * machine's projects only (names stay per machine). Resolves true once the list shows the new name.
   */
  onProjectRename?: (projectId: string, name: string | null) => Promise<boolean>;
  /** The project menu's Set picture… (letter marks): an image as a data: URL, or null to take it away. This machine's projects only. */
  onProjectPicture?: (projectId: string, file: File | null) => Promise<boolean>;
  /** One step of combining: `from` into `into`. Resolves true once the list shows it. */
  onProjectCombine?: (pair: { from: string; into: string; intoName: string }) => Promise<boolean>;
  /** "+" on a project row (approval "launch-create-clone", F1-F7): New message with a new session there. Absent: no "+". */
  onProjectNewSession?: (projectId: string, machine: string | null) => void;
  /** Whether a project's "+" can start anything there (its machine's agents, its folder, launch on there). Absent: every row's can. */
  projectCanStart?: (project: ProjectFolder, machine: string | null, machineLaunch: boolean | null | undefined) => boolean;
  /** Says a line in the window's live region (the rename field's refusals). */
  announce?: (text: string) => void;
  /** The update control's model (packages/server/inbox-updates.ts): the Update button above Settings. */
  update: InboxHealth['update'];
  restarting: boolean;
  /** This run started on a newer version: "What's new in X" above Settings. */
  updated: string | null;
  /**
   * Checking for updates has failed for hours (and no Update button shows):
   * the quiet "Can't check for updates" row, opening Settings → About.
   * Null on a tailnet guest's page.
   */
  checkFailing?: UpdateCheckFailing | null;
  onCheckFailing?: () => void;
  /**
   * Opens search (the approved "inbox-search" design): the field-shaped entry
   * under the Tater mark. No key hint, because no key opens it. Absent: no entry.
   */
  onSearch?: (opener: HTMLElement) => void;
  /** Compose (a new message to a connected agent): the icon button beside Search. Absent: no button. */
  onCompose?: (opener: HTMLElement) => void;
  /**
   * The threads pinned to the sidebar (approval "inbox-pinned-threads"), in
   * pin order: the Pinned section above Projects. None (or an older Inbox
   * that keeps no pins): no section at all.
   */
  pins?: readonly InboxListRow[];
  /** The thread on screen: its pinned row carries the selection pill. */
  openThreadId?: string | null;
  onOpenPin?: (row: InboxListRow) => void;
  onPinAction?: (row: InboxListRow, action: PinnedAction) => void;
  /** Drafts not sent: the Drafts row shows only while there are some. */
  draftsCount?: number;
  onDrafts?: () => void;
  /**
   * The list is on screen with no thread open: Inbox (when it shows every
   * project) or the project it shows, pressed now, refreshes it. On hover
   * its icon becomes ↻ with the tooltip "Refresh".
   */
  refreshes?: boolean;
  /** A refresh just ran (`scope`: the project, or null for Inbox): that row's ↻ turns once (the key restarts the turn). */
  refreshSpin?: { key: number; scope: string | null } | null;
  onInbox: () => void;
  onProject: (projectId: string) => void;
  onSettings: () => void;
  /** The keyboard button beside light and dark: the shortcut map (ShortcutMap.tsx). Absent, or on a phone: no button. */
  onShortcuts?: () => void;
  onUpdate: () => void;
  onWhatsNew: (version: string) => void;
  /**
   * Claude Code sessions a restart would bring up to date (the list model's
   * `restart_claude_code`): "Reload Claude Code N" under "What's new in X",
   * opening Settings → Agents (owner approval "restart-warning"). It goes away
   * by itself once they restart. Absent or 0: no row. `restartAgents` wins
   * when given (every runtime's count; owner approval "reload-hosts").
   */
  restartClaudeCode?: number;
  restartAgents?: InboxRestartAgents;
  onRestartSessions?: () => void;
  /**
   * `GET /api/inbox/settings` `mcp_command`, for the absolute `plannotator`
   * the connect prompt names; null until the settings load.
   */
  mcpCommand?: readonly string[] | null;
  /** The foot's Copy prompt pill (default true). The onboarding tour's sidebar leaves it out: it is for the person's own agents. */
  connectPrompt?: boolean;
  /** Opens the Feedback dialog (components/FeedbackDialog.tsx): the row above Settings. Absent: no row. */
  onFeedback?: () => void;
  /** Opens or closes the Usage peek from its row (components/Usage.tsx), which shows only where `cswap` is. Absent: no row. */
  onUsage?: (row: HTMLElement) => void;
  usageOpen?: boolean;
  /** `cswap` is on this computer: the row is there before the first read answers. */
  usageInstalled?: boolean;
  /** The foot stays hidden until it knows every row it will hold, so none arrives late and moves the others. */
  footHeld?: boolean;
  /**
   * Pinned and Projects open and close as this browser last left them (the
   * cookie in sidebarSections.ts; default true). The onboarding tour's
   * sidebar passes false: both start open whatever the cookie says.
   */
  rememberSections?: boolean;
}

/**
 * Whether a scroll area has more below what it shows: the project list fades
 * at its foot while it does, so a list cut mid-name says it scrolls.
 */
function useMoreBelow<T extends HTMLElement>(deps: unknown) {
  const ref = useRef<T>(null);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    read();
    el.addEventListener('scroll', read, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', read);
      observer?.disconnect();
    };
  }, [deps]);
  return [ref, more] as const;
}

/**
 * The Inbox's navigation: the Tater mark, the sections, the projects and
 * Settings. Drawn inside Workspaces' sidebar primitive (`../shell`): docked,
 * in the hover peek, and as the sheet on a phone width, which a pick closes.
 */
export function Sidebar(props: SidebarProps) {
  const restartAgents = props.restartAgents ?? restartAgentsOf(undefined, props.restartClaudeCode);
  const firstRun = props.projects.length === 0;
  const { setOpenMobile } = useSidebar();
  const searchKeys = useShortcutAria({ scope: inboxSearchShortcuts, action: 'openSearch' });
  const composeKeys = useShortcutAria({ scope: inboxAppShortcuts, action: 'compose' });
  const phone = usePhone();
  // Another machine's project keeps what that machine gives it: only this machine's are renamed or combined.
  const local = (project: ProjectFolder) => !project.machine || project.machine === selfMachineId();
  // A project with nothing in the list leaves the sidebar (automatic hiding); the one the list shows stays until the person leaves it.
  const held = props.page === 'inbox' ? props.projectId : null;
  // Each project by the window's one name for it (windowProjectNames, App.tsx), as the rows name it.
  const projectSort = useProjectSort();
  // Only most recent reads the activity, so another order does not sort again when a row's time changes.
  const activity = projectSort === 'recent' ? props.projectActivity : undefined;
  const shown = useMemo(
    () => sortProjects(shownProjects(props.projects, held).map((project) => ({ ...project, name: props.projectNames?.get(project.id) ?? project.name })), projectSort, activity),
    [props.projects, props.projectNames, held, projectSort, activity],
  );
  const pins = props.pins ?? [];
  // Pinned and Projects close like folders; closed, a section still shows where the person is (the open pinned thread, the project the list shows).
  const sections = useSidebarSections(props.rememberSections !== false);
  const pinnedClosed = sections.closed('pinned');
  const projectsClosed = sections.closed('projects');
  const pinOn = (row: InboxListRow) => props.page === 'inbox' && props.openThreadId === row.thread_id;
  // A closed Pinned counts the pins waiting on the person (a question, Stopped, Holds), so a Stopped thread never hides.
  // A snoozed pin stays pinned but waits with the rest of its snooze, so it is no count here.
  const pinsWaiting = pinnedClosed ? pins.filter((row) => !inboxRowSnoozed(row) && ['stop', 'hold', 'wait'].includes(pinnedState(row).kind)).length : 0;
  // One scroll area holds Pinned and Projects (no limit on pins: a long Pinned section scrolls with the projects).
  const [projsRef, moreProjects] = useMoreBelow<HTMLDivElement>(`${shown.length}:${pins.length}:${pinnedClosed}:${projectsClosed}`);
  /**
   * After a pin's menu acted: Move up or down keeps focus on that row's ⋯ in its new place; Unpin moves it to
   * the next pinned row's ⋯ on screen, else the first project on screen, else the Pinned header, else Inbox (never the page).
   */
  const pinFocus = useRef<{ id: string; index: number; fallback: string[]; until: number } | null>(null);
  useLayoutEffect(() => {
    const want = pinFocus.current;
    if (!want) return;
    const root = projsRef.current;
    if (Date.now() > want.until || !root) {
      pinFocus.current = null;
      return;
    }
    const lost = () => {
      const active = document.activeElement;
      return !active || active === document.body || !active.isConnected;
    };
    const index = pins.findIndex((p) => p.thread_id === want.id);
    // Still where it was: the write has not landed yet.
    if (index === want.index) return;
    pinFocus.current = null;
    if (index >= 0) {
      // Moved: the row's ⋯ in its new place.
      const own = root.querySelector<HTMLElement>(`[data-pin-more="${CSS.escape(want.id)}"]`);
      if (own && (lost() || document.activeElement === own)) own.focus({ preventScroll: true });
      return;
    }
    // Unpinned: the next pinned row's ⋯ on screen, else the first project on screen, else the Pinned header, else Inbox.
    if (!lost() && !root.contains(document.activeElement)) return;
    const next =
      want.fallback.map((id) => root.querySelector<HTMLElement>(`[data-pin-more="${CSS.escape(id)}"]`)).find((el) => el !== null) ??
      root.querySelector<HTMLElement>('.ib-proj') ??
      root.querySelector<HTMLElement>('[data-sidebar-section="pinned"]') ??
      inboxRef.current;
    next?.focus({ preventScroll: true });
  });
  const inboxRef = useRef<HTMLButtonElement>(null);
  const inboxRefreshes = props.refreshes === true && props.page === 'inbox' && props.projectId === null && !props.machineId;
  const spinOf = (scope: string | null) => (props.refreshSpin && props.refreshSpin.scope === scope ? props.refreshSpin.key : null);
  const refreshHintId = useId();
  const pinnedLabelId = useId();
  const pinnedBodyId = useId();
  const projectsLabelId = useId();
  const projectsBodyId = useId();
  const machinesLabelId = useId();
  const machinesBodyId = useId();
  const machineList = props.machines?.all ?? [];
  const machinesClosed = sections.closed('machines');
  /** The project a menu action ran on: once its row is gone (Archive all hid it), focus goes to Inbox, never the page. */
  const actedOn = useRef<string | null>(null);
  /** A project combined from its rename field: its row goes, and focus lands on the ⋯ of the project it went into. */
  const combinedInto = useRef<{ from: string; into: string } | null>(null);
  useLayoutEffect(() => {
    const combined = combinedInto.current;
    if (combined && !shown.some((p) => p.id === combined.from)) {
      combinedInto.current = null;
      asideRef.current?.querySelector<HTMLElement>(`[data-pmore="${combined.into}"]`)?.focus({ preventScroll: true });
    }
    const id = actedOn.current;
    if (!id || shown.some((p) => p.id === id)) return;
    actedOn.current = null;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) inboxRef.current?.focus({ preventScroll: true });
  });
  /**
   * The section that last held keyboard focus in this sidebar. A closed section's one row (the open pinned
   * thread, the project the list shows) goes when it stops being current (Escape closed the thread, Back left
   * the project): focus then moves to that section's header, never the page. Runs after Unpin's and Archive
   * all's own fallbacks, which move focus first.
   */
  const asideRef = useRef<HTMLElement>(null);
  const focusedIn = useRef<SidebarSection | null>(null);
  useEffect(() => {
    const track = (event: FocusEvent) => {
      const target = event.target instanceof Element && asideRef.current?.contains(event.target) ? event.target : null;
      focusedIn.current = target?.closest('[data-pinned-section]') ? 'pinned' : target?.closest('[data-machines-section]') ? 'machines' : target?.closest('.ib-projs') ? 'projects' : null;
    };
    document.addEventListener('focusin', track);
    return () => document.removeEventListener('focusin', track);
  }, []);
  useLayoutEffect(() => {
    const section = focusedIn.current;
    if (!section || !sections.closed(section)) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    focusedIn.current = null;
    asideRef.current?.querySelector<HTMLElement>(`[data-sidebar-section="${section}"]`)?.focus({ preventScroll: true });
  });
  const pick = (go: () => void) => () => {
    setOpenMobile(false);
    go();
  };
  return (
    <aside ref={asideRef} className="ib-side" aria-label="Inbox navigation">
      <div className="ib-brand">
        <TaterMark />
        <b>Plannotator</b>
        <span>Inbox</span>
      </div>
      {props.onSearch && (
        <div className="ib-sp-entryrow">
        <button
          type="button"
          className="ib-sp-entry"
          data-open-search=""
          aria-haspopup="dialog"
          aria-keyshortcuts={searchKeys}
          onClick={(event) => {
            const opener = event.currentTarget;
            // On a phone the sheet closes first; the search sheet takes the screen.
            setOpenMobile(false);
            props.onSearch?.(opener);
          }}
        >
          <Icon name="search" />
          Search
          {/* ⌘K / Ctrl K (search/searchShortcut.ts); the button's aria-keyshortcuts names it, and `/`, for a screen reader. */}
          <ShortcutHint scope={inboxSearchShortcuts} action="openSearch" className="ib-kbd ib-sp-hint" />
        </button>
        {props.onCompose && (
          <Tip content={withShortcut('New message', { scope: inboxAppShortcuts, action: 'compose' })}>
            <button
              type="button"
              className="ib-compose-btn"
              data-open-compose=""
              aria-label="New message"
              aria-keyshortcuts={composeKeys}
              aria-haspopup="dialog"
              onClick={(event) => {
                const opener = event.currentTarget;
                setOpenMobile(false);
                props.onCompose?.(opener);
              }}
            >
              <Icon name="compose" />
            </button>
          </Tip>
        )}
        </div>
      )}
      {/* On the list it shows, Inbox refreshes it: ↻ on hover with "Refresh", one turn on a click. */}
      <Tip content="Refresh" when={() => inboxRefreshes}>
        <button
          ref={inboxRef}
          type="button"
          className={`ib-nav ib-nav-inbox${props.page === 'inbox' && props.projectId === null && !props.machineId ? ' ib-on' : ''}`}
          onClick={pick(props.onInbox)}
          aria-current={props.page === 'inbox' && props.projectId === null && !props.machineId ? 'page' : undefined}
          aria-describedby={inboxRefreshes ? refreshHintId : undefined}
          data-refreshes={inboxRefreshes ? '' : undefined}
          data-refreshing={spinOf(null) != null ? '' : undefined}
          data-inbox-nav=""
        >
          <span className="ib-nav-ics" aria-hidden="true">
            <Icon name="inbox" className="ib-ic-inbox" />
            <Icon key={spinOf(null) ?? 'rest'} name="refresh" className="ib-ic-refresh" />
          </span>
          Inbox
          {!firstRun && props.inboxCount > 0 && <span className="ib-n">{formatCount(props.inboxCount)}</span>}
        </button>
      </Tip>
      <span id={refreshHintId} hidden>
        Refresh the list
      </span>
      {props.onBoard && (
        <button
          type="button"
          className={`ib-nav${props.page === 'board' ? ' ib-on' : ''}`}
          onClick={pick(props.onBoard)}
          aria-current={props.page === 'board' ? 'page' : undefined}
          data-board-nav=""
        >
          <Icon name="board" />
          Board
        </button>
      )}
      {props.onShape && (
        <button
          type="button"
          className={`ib-nav${props.page === 'shapes' ? ' ib-on' : ''}`}
          onClick={pick(props.onShape)}
          aria-current={props.page === 'shapes' ? 'page' : undefined}
          data-shape-nav=""
        >
          <span className="ib-pebble-ico" aria-hidden="true">
            <Pebble alive={false} size={18} />
          </span>
          Shape
          {(props.shapeChanged ?? 0) > 0 && (
            <span className="ib-n" aria-label={`${props.shapeChanged} changed since you looked`}>
              {formatCount(props.shapeChanged ?? 0)}
            </span>
          )}
        </button>
      )}
      {props.onPulls && (
        <button
          type="button"
          className={`ib-nav${props.page === 'reviews' ? ' ib-on' : ''}`}
          onClick={pick(props.onPulls)}
          aria-current={props.page === 'reviews' ? 'page' : undefined}
          data-pulls-nav=""
        >
          <Icon name="reviews" />
          Reviews
          {(props.pullsCount ?? 0) > 0 && (
            <span className="ib-n" aria-label={`${props.pullsCount} on you`}>
              {formatCount(props.pullsCount ?? 0)}
            </span>
          )}
        </button>
      )}
      {props.onArtifacts && (
        <button
          type="button"
          className={`ib-nav${props.page === 'artifacts' ? ' ib-on' : ''}`}
          onClick={pick(props.onArtifacts)}
          aria-current={props.page === 'artifacts' ? 'page' : undefined}
          data-artifacts-nav=""
        >
          <Icon name="artifacts" />
          Artifacts
        </button>
      )}
      {(props.draftsCount ?? 0) > 0 && props.onDrafts && (
        <button
          type="button"
          className={`ib-nav${props.page === 'drafts' ? ' ib-on' : ''}`}
          onClick={pick(props.onDrafts)}
          aria-current={props.page === 'drafts' ? 'page' : undefined}
          data-drafts-nav=""
        >
          <Icon name="doc" />
          Drafts
          <span className="ib-n">{formatCount(props.draftsCount ?? 0)}</span>
        </button>
      )}
      <div className="ib-sidescroll" ref={projsRef} data-more={moreProjects ? '' : undefined}>
        {pins.length > 0 && (
          <>
            <SectionHeader
              section="pinned"
              id={pinnedLabelId}
              controls={pinnedBodyId}
              label="Starred"
              icon="star"
              iconClass="ib-star-on"
              pop={starPopping()}
              open={!pinnedClosed}
              count={pinsWaiting}
              onToggle={() => sections.toggle('pinned')}
            />
            <section className="ib-pins" id={pinnedBodyId} aria-labelledby={pinnedLabelId} data-pinned-section="" data-closed={pinnedClosed ? '' : undefined}>
              {pins.map((row, index) => (pinnedClosed && !pinOn(row) ? null : (
                <PinnedRow
                  key={row.thread_id}
                  row={row}
                  project={props.projectNames?.get(row.project.id)}
                  on={pinOn(row)}
                  first={index === 0}
                  last={index === pins.length - 1}
                  phone={phone}
                  onOpen={pick(() => props.onOpenPin?.(row))}
                  onAction={(action) => {
                    if (action === 'up' || action === 'down' || action === 'unpin') {
                      const rest = pins.map((p) => p.thread_id).filter((id) => id !== row.thread_id);
                      pinFocus.current = { id: row.thread_id, index, fallback: [...rest.slice(index), ...rest.slice(0, index).reverse()], until: Date.now() + 5000 };
                    }
                    // On a phone the sheet closes for Unpin and Copy link, so their toast is in view; a move keeps it open.
                    if (phone && (action === 'unpin' || action === 'copy-link')) setOpenMobile(false);
                    props.onPinAction?.(row, action);
                  }}
                />
              )))}
            </section>
          </>
        )}
        {machineList.length > 0 && props.onMachine && (
          <>
            {/* Linked machines: a filter as a project is, this machine first. A machine that is away reads quiet, as a
                project with nothing waiting does, and its tooltip says since when. */}
            <SectionHeader
              section="machines"
              id={machinesLabelId}
              controls={machinesBodyId}
              label="Machines"
              icon="system"
              open={!machinesClosed}
              count={0}
              onToggle={() => sections.toggle('machines')}
            />
            <div className="ib-projs" id={machinesBodyId} role="group" aria-labelledby={machinesLabelId} data-machines-section="" data-closed={machinesClosed ? '' : undefined}>
              {machineList.map((machine) => {
                const n = props.machineCounts?.get(machine.id) ?? 0;
                const on = props.page === 'inbox' && props.machineId === machine.id && props.projectId === null;
                if (machinesClosed && !on) return null;
                const away = isAway(machine);
                return (
                  <Tip key={machine.id} content={machine.self ? 'This machine' : (awayLine(machine) ?? machine.name)} side="right">
                    <button
                      type="button"
                      className={`ib-proj${n === 0 || away ? ' ib-proj-quiet' : ''}${on ? ' ib-on' : ''}`}
                      onClick={pick(() => props.onMachine?.(machine.id))}
                      aria-current={on ? 'page' : undefined}
                      data-machine={machine.id}
                      data-away={away ? '' : undefined}
                    >
                      <span className="ib-name" dir="auto">{machine.name}</span>
                      {away && <span className="ib-sr">, {awayLine(machine)}</span>}
                      {n > 0 && <span className="ib-n">{formatCount(n)}</span>}
                    </button>
                  </Tip>
                );
              })}
            </div>
          </>
        )}
        {/* Two controls side by side, never one inside the other: the header opens and closes, the icon changes the order. */}
        <div className="ib-secrow">
          <SectionHeader
            section="projects"
            id={projectsLabelId}
            controls={projectsBodyId}
            label="Projects"
            icon={projectsClosed ? 'folder' : 'folderOpen'}
            open={!projectsClosed}
            count={0}
            onToggle={() => sections.toggle('projects')}
          />
          {!projectsClosed && shown.length > 1 && <ProjectSortToggle sort={projectSort} announce={props.announce} />}
        </div>
        <div className="ib-projs" id={projectsBodyId} role="group" aria-labelledby={projectsLabelId} data-closed={projectsClosed ? '' : undefined} data-recent={projectSort === 'recent' ? '' : undefined}>
          {/* Closed: only the project the list shows, if any; never the empty notes. */}
          {firstRun ? (
            !projectsClosed && <div className="ib-side-empty">Projects appear here when an agent writes from one.</div>
          ) : shown.length === 0 ? (
            !projectsClosed && (
              <div className="ib-side-empty" data-projects-hidden="">
                {/* Projects whose threads were deleted rather than archived are not in Settings → Archived. */}
                {props.projects.some((project) => (project.archived ?? 0) > 0) ? 'Nothing open. Archived projects are in Settings → Archived.' : 'Nothing open.'}
              </div>
            )
          ) : (
            shown.map((project) => {
              const n = props.projectCounts.get(project.id) ?? 0;
              const on = props.page === 'inbox' && props.projectId === project.id;
              if (projectsClosed && !on) return null;
              if (!props.onProjectAction) {
                return (
                  <ProjectTip key={project.id} name={project.name} root={project.root}>
                    <button
                      type="button"
                      className={`ib-proj${n === 0 ? ' ib-proj-quiet' : ''}${on ? ' ib-on' : ''}`}
                      onClick={pick(() => props.onProject(project.id))}
                      aria-current={on ? 'page' : undefined}
                    >
                      <span className="ib-name" dir="auto">{project.name}</span>
                      {n > 0 && <span className="ib-n">{formatCount(n)}</span>}
                    </button>
                  </ProjectTip>
                );
              }
              return (
                <ProjectRow
                  key={project.id}
                  project={project}
                  count={n}
                  on={on}
                  held={project.listed === 0}
                  refreshes={on && props.refreshes === true}
                  refreshSpin={spinOf(project.id)}
                  readable={props.projectsReadable?.has(project.id) ?? false}
                  phone={phone}
                  onOpen={pick(() => props.onProject(project.id))}
                  onAction={(action) => {
                    actedOn.current = project.id;
                    // On a phone the navigation sheet closes, so the toast and the list are in view.
                    setOpenMobile(false);
                    props.onProjectAction?.(project.id, action);
                  }}
                  // Another machine's project keeps the name that machine gives it. The sheet stays open on a phone: the field is in it.
                  onRename={
                    props.onProjectRename && (!project.machine || project.machine === selfMachineId())
                      ? (name) => props.onProjectRename!(project.id, name)
                      : undefined
                  }
                  // A picture is kept by the Inbox that has the project: this machine's projects only.
                  onPicture={props.onProjectPicture && local(project) ? (file) => props.onProjectPicture!(project.id, file) : undefined}
                  newSession={
                    props.onProjectNewSession
                      ? (() => {
                          const machine = project.machine && project.machine !== props.machines?.self ? project.machine : null;
                          const machineView = machine ? props.machines?.linked.find((m) => m.id === machine) : undefined;
                          if (props.projectCanStart && !props.projectCanStart(project, machine, machineView?.launch)) return undefined;
                          const tip = newSessionTip(props.projectNames?.get(project.id) ?? project.name, machine ? (props.machines?.names.get(machine) ?? null) : null, machineView?.state === 'offline');
                          return {
                            tip,
                            onPress: () => {
                              setOpenMobile(false);
                              props.onProjectNewSession!(project.id, machine);
                            },
                          };
                        })()
                      : undefined
                  }
                  announce={props.announce}
                  // This machine's projects only: combining never crosses machines.
                  others={local(project) ? props.projects.filter((p) => p.id !== project.id && local(p)).map((p) => ({ ...p, name: props.projectNames?.get(p.id) ?? p.name })) : []}
                  onCombine={
                    props.onProjectCombine && local(project)
                      ? async (into) => {
                          combinedInto.current = { from: project.id, into: into.id };
                          setOpenMobile(false);
                          // The name it will have: alone again, it loses a clash's parent.
                          const intoName = shortProjectNames([into]).get(into.id) ?? into.name;
                          const done = await props.onProjectCombine!({ from: project.id, into: into.id, intoName });
                          if (!done) combinedInto.current = null;
                          return done;
                        }
                      : undefined
                  }
                />
              );
            })
          )}
        </div>
      </div>
      <div className="ib-side-foot" data-held={props.footHeld ? '' : undefined}>
        {/* Copy prompt first, then the Update button or "What's new in X", then Feedback and the Settings row. */}
        {props.connectPrompt !== false && !phone && <CopyConnectPrompt mcpCommand={props.mcpCommand ?? null} />}
        <UpdateButton
          update={props.update}
          restarting={props.restarting}
          updated={props.updated}
          onPress={pick(props.onUpdate)}
          onWhatsNew={(version) => pick(() => props.onWhatsNew(version))()}
        />
        {!props.update && props.checkFailing && props.onCheckFailing && (
          <CheckFailingRow failing={props.checkFailing} onOpen={pick(props.onCheckFailing)} />
        )}
        {restartAgents.total > 0 && props.onRestartSessions && <RestartSessionsRow agents={restartAgents} onOpen={pick(props.onRestartSessions)} />}
        {props.onFeedback && (
          <button type="button" className="ib-nav" aria-haspopup="dialog" data-feedback-nav="" onClick={pick(props.onFeedback)}>
            <Icon name="comment" />
            Feedback
          </button>
        )}
        {props.onUsage && <UsageRow installed={props.usageInstalled ?? false} open={props.usageOpen ?? false} onOpen={(row) => pick(() => props.onUsage?.(row))()} />}
        {/* Two controls side by side, never one inside the other: the row opens Settings, the icon flips light and dark. */}
        <div className="ib-setrow">
          <button
            type="button"
            className={`ib-nav${props.page === 'settings' ? ' ib-on' : ''}${props.onShortcuts && !phone ? ' ib-has-keys' : ''}`}
            onClick={pick(props.onSettings)}
            aria-current={props.page === 'settings' ? 'page' : undefined}
          >
            <Icon name="settings" />
            Settings
          </button>
          {props.onShortcuts && !phone && <KeysButton onPress={props.onShortcuts} />}
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}

/**
 * A section's header (owner's pick, direction C "The section is the folder"):
 * a quiet row with the section's icon (a pin; a folder, open while the
 * section is), its name, and a chevron that turns down while open. A click,
 * Enter or Space anywhere on it opens or closes the section; no shortcut.
 * Closed, Pinned shows how many pins wait on the person (the project rows'
 * count style); the chevron takes the count's place on hover, and on a phone
 * both show. Not navigation: the phone sheet stays open.
 */
function SectionHeader(props: {
  section: SidebarSection;
  id: string;
  controls: string;
  label: string;
  icon: IconName;
  iconClass?: string;
  /** The section's star takes the little pop: a thread was starred just now. */
  pop?: boolean;
  open: boolean;
  count: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      id={props.id}
      className="ib-side-sec"
      aria-expanded={props.open}
      aria-controls={props.controls}
      data-sidebar-section={props.section}
      onClick={props.onToggle}
    >
      <Icon name={props.icon} className={[props.iconClass, props.pop ? 'ib-star-pop' : ''].filter(Boolean).join(' ') || undefined} />
      <span className="ib-side-sec-l">{props.label}</span>
      <span className="ib-side-sec-tail">
        {props.count > 0 && (
          <span className="ib-n">
            {formatCount(props.count)}
            <span className="ib-sr"> waiting on you</span>
          </span>
        )}
        <Icon name="chevR" className="ib-side-sec-chev" />
      </span>
    </button>
  );
}

/**
 * The order of Projects, one quiet icon beside the header's chevron: the icon
 * is the order on screen, a press goes to the next. It shows on the header's
 * hover and keyboard focus; where nothing hovers (a phone, a tablet) it always
 * shows. Only with two projects or more, and only while the section is open.
 * Not navigation: the phone sheet stays open. Going while it holds focus (the
 * list fell to one project), it hands focus to the header, never the page.
 */
function ProjectSortToggle({ sort, announce }: { sort: ProjectSort; announce?: (text: string) => void }) {
  const { icon, label, next, said } = projectSortControl(sort);
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const node = button.current;
    return () => {
      if (node && node === document.activeElement) node.closest('.ib-secrow')?.querySelector<HTMLElement>('[data-sidebar-section]')?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <Tip content={label}>
      <button
        ref={button}
        type="button"
        className="ib-proj-sort"
        aria-label={label}
        data-projects-sort={sort}
        onClick={() => {
          setProjectSort(next);
          announce?.(said);
        }}
      >
        <Icon name={icon} />
      </button>
    </Tip>
  );
}

/**
 * "Reload Claude Code N" (owner approval "restart-warning"), generalized to
 * every runtime (owner approval "reload-hosts"): the sessions still on the
 * Plannotator from before an update. One runtime names itself ("Reload Pi",
 * "Restart Oh My Pi"); more than one reads "Reload agents". A real button
 * named by its words and count; what it does is in its description. Opens
 * Settings → Agents, which lists them.
 */
function RestartSessionsRow({ agents, onOpen }: { agents: InboxRestartAgents; onOpen: () => void }) {
  return (
    <button type="button" className="ib-nav ib-quiet ib-rw-restart" data-restart-sidebar={agents.total} onClick={onOpen}>
      <Icon name="refresh" />
      <span className="ib-rw-label">{restartAgentsLabel(agents)}</span>
      <span className="ib-n">{formatCount(agents.total)}</span>
      <span className="ib-sr">. {restartAgentsDescription(agents)}</span>
    </button>
  );
}

/** How long the row reads "Copied" before it goes back to its name. */
export const CONNECT_COPIED_MS = 2000;
/** A failed copy stays on screen a little longer, so it is read. */
export const CONNECT_COPY_FAILED_MS = 4000;
export const CONNECT_COPIED_ANNOUNCEMENT = 'Connect prompt copied.';
export const CONNECT_COPY_FAILED_ANNOUNCEMENT = "Couldn't copy the connect prompt.";

/**
 * "Copy connect prompt" (owner approval 2026-10-13, design record
 * `inbox-sidebar-connect-prompt`; its look amended 2026-10-15 by
 * `inbox-connect-row`, option 1b): an outlined pill above the Update button
 * (or "What's new in X") and Settings, with the four agent marks and "Copy
 * prompt", which copies the prompt an agent on this computer needs to
 * connect itself (connectPrompt.ts). Only a copy
 * button: no preview, no tooltip, no shortcut. The label says "Copied" for
 * 2 s (or "Couldn't copy"), the marks stay, focus stays on it, and a polite
 * live region says the same. Its name reads "Copy prompt to connect an
 * agent": the visible words first, then what they are for. Not navigation,
 * so the phone sheet stays open to show it. Not drawn on a phone (owner:
 * it does not need to show there); the tailnet page on a desktop shows it.
 */
function CopyConnectPrompt({ mcpCommand }: { mcpCommand: readonly string[] | null }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [announcement, setAnnouncement] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    const mine = ++attempt.current;
    const ok = await copyTextToClipboard(connectPrompt(mcpCommand));
    if (mine !== attempt.current) return;
    if (timer.current) clearTimeout(timer.current);
    setState(ok ? 'copied' : 'failed');
    // The same words twice in a row are not read again: a trailing no-break space makes each one new.
    const words = ok ? CONNECT_COPIED_ANNOUNCEMENT : CONNECT_COPY_FAILED_ANNOUNCEMENT;
    setAnnouncement((last) => (last === words ? `${words}\u00a0` : words));
    timer.current = setTimeout(() => setState('idle'), ok ? CONNECT_COPIED_MS : CONNECT_COPY_FAILED_MS);
  };
  return (
    <>
      <button
        type="button"
        className="ib-cpill"
        data-connect-prompt={state}
        onClick={() => void copy()}
      >
        <span className="ib-cpill-ags" aria-hidden="true">
          <ClaudeIcon className="ib-cpill-ag" />
          <CodexIcon className="ib-cpill-ag" />
          <PiIcon className="ib-cpill-ag" />
          <OpenCodeIcon className="ib-cpill-ag" />
        </span>
        {state === 'idle' ? (
          <span className="ib-cpill-l">
            Copy prompt<span className="ib-sr"> to connect an agent</span>
          </span>
        ) : (
          <>
            <Icon name={state === 'copied' ? 'check' : 'warn'} />
            <span className="ib-cpill-l">{state === 'copied' ? 'Copied' : "Couldn't copy"}</span>
          </>
        )}
      </button>
      <div className="ib-sr" role="status" aria-live="polite" data-connect-prompt-live="">
        {announcement}
      </div>
    </>
  );
}

/**
 * Light or dark in one click, at the far right of the Settings row. It writes
 * an explicit choice, the opposite of what is on screen (Settings' Theme row
 * goes back to matching the system). A click here never opens Settings and
 * never closes the phone sheet or the peek.
 */
/** The shortcut map's button, left of light and dark (approval "inbox-keyboard-shortcuts"). */
function KeysButton({ onPress }: { onPress: () => void }) {
  const keys = useShortcutAria({ scope: inboxAppShortcuts, action: 'openMap' });
  return (
    <Tip content={withShortcut('Keyboard shortcuts', { scope: inboxAppShortcuts, action: 'openMap' })}>
      <button type="button" className="ib-keys-tg" aria-label="Keyboard shortcuts" aria-haspopup="dialog" aria-keyshortcuts={keys} onClick={onPress} data-shortcut-map-button="">
        <Icon name="keyboard" />
      </button>
    </Tip>
  );
}

function ThemeToggle() {
  const { shown, flip } = useInboxTheme();
  const next = shown === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} mode`;
  return (
    <Tip content={label}>
      <button type="button" className="ib-theme-tg" aria-label={label} data-theme-toggle={shown} onClick={flip}>
        <Icon name={next === 'light' ? 'sun' : 'moon'} />
      </button>
    </Tip>
  );
}
