import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { InboxHealth } from '@plannotator/core/inbox-types';
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
import { useInboxTheme } from '../theme';
import { TaterMark } from './TaterMark';
import { ProjectTip } from './ProjectRow';
import { Tip } from './Tip';
import { UpdateButton } from './Updates';
import { openSearchAriaKeys, openSearchHint } from '../search/searchShortcut';

export interface SidebarProps {
  page: 'inbox' | 'settings' | 'whats-new' | 'drafts' | 'board';
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
   * Opens search (the approved "inbox-search" design): the field-shaped entry
   * under the Tater mark. No key hint, because no key opens it. Absent: no entry.
   */
  onSearch?: (opener: HTMLElement) => void;
  /** Compose (a new message to a connected agent): the icon button beside Search. Absent: no button. */
  onCompose?: (opener: HTMLElement) => void;
  /**
   * The Board (approval "inbox-board"): its row under Inbox, counting the
   * cards waiting on the person (Your look and Your review). Absent: no row.
   */
  onBoard?: () => void;
  /** The cards on the person plus an agent's drops they have not seen (so a drop reaches them without opening the Board). */
  boardCount?: number;
  /** Of `boardCount`, the agent's unseen drops (said in the row's name). */
  boardDropped?: number;
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
   * by itself once they restart. Absent or 0: no row.
   */
  restartClaudeCode?: number;
  onRestartSessions?: () => void;
  /**
   * `GET /api/inbox/settings` `mcp_command`, for the absolute `plannotator`
   * the connect prompt names; null until the settings load.
   */
  mcpCommand?: readonly string[] | null;
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
  const firstRun = props.projects.length === 0;
  const { setOpenMobile } = useSidebar();
  const phone = usePhone();
  // A project with nothing in the list leaves the sidebar (automatic hiding); the one the list shows stays until the person leaves it.
  const held = props.page === 'inbox' ? props.projectId : null;
  const shown = shownProjects(props.projects, held);
  const [projsRef, moreProjects] = useMoreBelow<HTMLDivElement>(shown.length);
  const inboxRef = useRef<HTMLButtonElement>(null);
  const inboxRefreshes = props.refreshes === true && props.page === 'inbox' && props.projectId === null;
  const spinOf = (scope: string | null) => (props.refreshSpin && props.refreshSpin.scope === scope ? props.refreshSpin.key : null);
  const refreshHintId = useId();
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
          {(props.boardCount ?? 0) > 0 && (
            <span
              className="ib-n"
              data-board-count=""
              aria-label={`${(props.boardCount ?? 0) - (props.boardDropped ?? 0)} on you${(props.boardDropped ?? 0) > 0 ? `, ${props.boardDropped} dropped by an agent` : ''}`}
            >
              {formatCount(props.boardCount ?? 0)}
            </span>
          )}
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
      <div className="ib-side-label">Projects</div>
      <div className="ib-projs" ref={projsRef} data-more={moreProjects ? '' : undefined}>
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
      <div className="ib-side-foot">
        {/* Copy prompt first, then the Update button or "What's new in X", then the Settings row. */}
        <CopyConnectPrompt mcpCommand={props.mcpCommand ?? null} />
        <UpdateButton
          update={props.update}
          restarting={props.restarting}
          updated={props.updated}
          onPress={pick(props.onUpdate)}
          onWhatsNew={(version) => pick(() => props.onWhatsNew(version))()}
        />
        {(props.restartClaudeCode ?? 0) > 0 && props.onRestartSessions && (
          <RestartSessionsRow count={props.restartClaudeCode ?? 0} onOpen={pick(props.onRestartSessions)} />
        )}
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
 * "Reload Claude Code N": the Claude Code sessions still on the plugin from
 * before an update. A real button named by its words and count; what it does
 * is in its description. Opens Settings → Agents, which lists them.
 */
function RestartSessionsRow({ count, onOpen }: { count: number; onOpen: () => void }) {
  const why = `${count === 1 ? '1 Claude Code session runs' : `${count} Claude Code sessions run`} the plugin from before the update; /reload-plugins loads the new one. Opens Settings, Agents.`;
  return (
    <button type="button" className="ib-nav ib-quiet ib-rw-restart" data-restart-sidebar={count} onClick={onOpen}>
      <Icon name="refresh" />
      <span className="ib-rw-label">Reload Claude Code</span>
      <span className="ib-n">{formatCount(count)}</span>
      <span className="ib-sr">. {why}</span>
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
