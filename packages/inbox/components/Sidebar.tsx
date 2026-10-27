import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { InboxHealth, InboxListRow, InboxRestartAgents } from '@plannotator/core/inbox-types';
import { restartAgentsDescription, restartAgentsLabel, restartAgentsOf } from '../restartAgents';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { ClaudeIcon, CodexIcon, OpenCodeIcon, PiIcon } from '@plannotator/ui/components/icons/AgentIcons';
import type { ProjectFolder } from '../api';
import { connectPrompt } from '../connectPrompt';
import { formatCount } from '../format';
import { Icon } from '../icons';
import { useSidebar } from '../shell/sidebar';
import { usePhone } from '../phone';
import { shownProjects, type ProjectAction } from '../projectMenu';
import { ProjectRow } from './ProjectRow';
import { PinnedRow, type PinnedAction } from './PinnedRow';
import { useInboxTheme } from '../theme';
import { TaterMark } from './TaterMark';
import { ProjectTip } from './ProjectRow';
import { Tip } from './Tip';
import { CheckFailingRow, UpdateButton } from './Updates';
import type { UpdateCheckFailing } from '../api';
import { openSearchAriaKeys, openSearchHint } from '../search/searchShortcut';

export interface SidebarProps {
  page: 'inbox' | 'settings' | 'whats-new' | 'drafts' | 'board';
  /**
   * The Board (approval "inbox-board", step 2): the row under Inbox, always
   * shown with `onBoard`. No count: the approval keeps the count in the
   * Board's header ("N in flight · N on you").
   */
  onBoard?: () => void;
  projectId: string | null;
  /** Rows waiting on the person, all projects. */
  inboxCount: number;
  projects: readonly ProjectFolder[];
  /** Rows waiting on the person, per project id. */
  projectCounts: ReadonlyMap<string, number>;
  /**
   * The project menu (design record "inbox-project-menu"): the projects where
   * Mark all as read has something to do, and the action. Absent: no menu.
   */
  projectsReadable?: ReadonlySet<string>;
  onProjectAction?: (projectId: string, action: ProjectAction) => void;
  /** The update control's model (packages/server/inbox-updates.ts): the Update button above Settings. */
  update: InboxHealth['update'];
  restarting: boolean;
  /** This run started on a newer version: "What's new in X" above Settings. */
  updated: string | null;
  /**
   * Checking for updates has failed for hours (and no Update button shows):
   * the quiet "Can't check for updates" row, opening Settings → About.
   * Null on a page opened over the tailnet.
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
  const phone = usePhone();
  // A project with nothing in the list leaves the sidebar (automatic hiding); the one the list shows stays until the person leaves it.
  const held = props.page === 'inbox' ? props.projectId : null;
  const shown = shownProjects(props.projects, held);
  const pins = props.pins ?? [];
  // One scroll area holds Pinned and Projects (no limit on pins: a long Pinned section scrolls with the projects).
  const [projsRef, moreProjects] = useMoreBelow<HTMLDivElement>(`${shown.length}:${pins.length}`);
  /**
   * After a pin's menu acted: Move up or down keeps focus on that row's ⋯ in its new place; Unpin moves it to
   * the next pinned row's ⋯, else the first project, else Inbox (never the page).
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
    // Unpinned: the next pinned row's ⋯, else the first project, else Inbox.
    if (!lost() && !root.contains(document.activeElement)) return;
    const next =
      want.fallback.map((id) => root.querySelector<HTMLElement>(`[data-pin-more="${CSS.escape(id)}"]`)).find((el) => el !== null) ??
      root.querySelector<HTMLElement>('.ib-proj') ??
      inboxRef.current;
    next?.focus({ preventScroll: true });
  });
  const inboxRef = useRef<HTMLButtonElement>(null);
  const inboxRefreshes = props.refreshes === true && props.page === 'inbox' && props.projectId === null;
  const spinOf = (scope: string | null) => (props.refreshSpin && props.refreshSpin.scope === scope ? props.refreshSpin.key : null);
  const refreshHintId = useId();
  const pinnedLabelId = useId();
  /** The project a menu action ran on: once its row is gone (Archive all hid it), focus goes to Inbox, never the page. */
  const actedOn = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = actedOn.current;
    if (!id || shown.some((p) => p.id === id)) return;
    actedOn.current = null;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) inboxRef.current?.focus({ preventScroll: true });
  });
  const pick = (go: () => void) => () => {
    setOpenMobile(false);
    go();
  };
  return (
    <aside className="ib-side" aria-label="Inbox navigation">
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
          aria-keyshortcuts={openSearchAriaKeys()}
          onClick={(event) => {
            const opener = event.currentTarget;
            // On a phone the sheet closes first; the search sheet takes the screen.
            setOpenMobile(false);
            props.onSearch?.(opener);
          }}
        >
          <Icon name="search" />
          Search
          {/* The Inbox's one shortcut (search/searchShortcut.ts); the button's aria-keyshortcuts names it for a screen reader. */}
          <kbd className="ib-kbd ib-sp-hint" aria-hidden="true" data-search-hint="">
            {openSearchHint()}
          </kbd>
        </button>
        {props.onCompose && (
          <Tip content="New message">
            <button
              type="button"
              className="ib-compose-btn"
              data-open-compose=""
              aria-label="New message"
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
          className={`ib-nav ib-nav-inbox${props.page === 'inbox' && props.projectId === null ? ' ib-on' : ''}`}
          onClick={pick(props.onInbox)}
          aria-current={props.page === 'inbox' && props.projectId === null ? 'page' : undefined}
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
            <div className="ib-side-label" id={pinnedLabelId}>
              Pinned
            </div>
            <section className="ib-pins" aria-labelledby={pinnedLabelId} data-pinned-section="">
              {pins.map((row, index) => (
                <PinnedRow
                  key={row.thread_id}
                  row={row}
                  on={props.page === 'inbox' && props.openThreadId === row.thread_id}
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
              ))}
            </section>
          </>
        )}
        <div className="ib-side-label">Projects</div>
        <div className="ib-projs">
          {firstRun ? (
            <div className="ib-side-empty">Projects appear here when an agent writes from one.</div>
          ) : shown.length === 0 ? (
            <div className="ib-side-empty" data-projects-hidden="">
              {/* Projects whose threads were deleted rather than archived are not in Settings → Archived. */}
              {props.projects.some((project) => (project.archived ?? 0) > 0) ? 'Nothing open. Archived projects are in Settings → Archived.' : 'Nothing open.'}
            </div>
          ) : (
            shown.map((project) => {
              const n = props.projectCounts.get(project.id) ?? 0;
              const on = props.page === 'inbox' && props.projectId === project.id;
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
                />
              );
            })
          )}
        </div>
      </div>
      <div className="ib-side-foot">
        {/* Copy prompt first, then the Update button or "What's new in X", then the Settings row. */}
        {props.connectPrompt !== false && <CopyConnectPrompt mcpCommand={props.mcpCommand ?? null} />}
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
        {/* Two controls side by side, never one inside the other: the row opens Settings, the icon flips light and dark. */}
        <div className="ib-setrow">
          <button
            type="button"
            className={`ib-nav${props.page === 'settings' ? ' ib-on' : ''}`}
            onClick={pick(props.onSettings)}
            aria-current={props.page === 'settings' ? 'page' : undefined}
          >
            <Icon name="settings" />
            Settings
          </button>
          <ThemeToggle />
        </div>
      </div>
    </aside>
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
 * so the phone sheet stays open to show it. Shown everywhere, the tailnet
 * included.
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
