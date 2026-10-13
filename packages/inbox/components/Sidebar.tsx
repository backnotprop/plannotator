import { useEffect, useRef, useState } from 'react';
import type { InboxHealth } from '@plannotator/core/inbox-types';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import type { ProjectFolder } from '../api';
import { connectPrompt } from '../connectPrompt';
import { Icon } from '../icons';
import { useSidebar } from '../shell/sidebar';
import { useInboxTheme } from '../theme';
import { TaterMark } from './TaterMark';
import { UpdateButton } from './Updates';

export interface SidebarProps {
  page: 'inbox' | 'settings' | 'decisions' | 'whats-new';
  projectId: string | null;
  /** Rows waiting on the person, all projects. */
  inboxCount: number;
  /** Questions that record a decision once answered and sent, all projects. */
  decisionsCount: number;
  projects: readonly ProjectFolder[];
  /** Rows waiting on the person, per project id. */
  projectCounts: ReadonlyMap<string, number>;
  /** The update control's model (packages/server/inbox-updates.ts): the Update button above Settings. */
  update: InboxHealth['update'];
  restarting: boolean;
  /** This run started on a newer version: "What's new in X" above Settings. */
  updated: string | null;
  onInbox: () => void;
  onProject: (projectId: string) => void;
  onSettings: () => void;
  onDecisions: () => void;
  onUpdate: () => void;
  onWhatsNew: (version: string) => void;
  /**
   * The question sound is on and the tab has had no click yet, so Chrome
   * would keep it silent: a quiet line above Settings. Any click in the tab
   * (this one too) turns the sound on, and the line goes.
   */
  soundNeedsClick?: boolean;
  /**
   * `GET /api/inbox/settings` `mcp_command`, for the absolute `plannotator`
   * the connect prompt names; null until the settings load.
   */
  mcpCommand?: readonly string[] | null;
}

/**
 * The Inbox's navigation: the Tater mark, the sections, the projects and
 * Settings. Drawn inside Workspaces' sidebar primitive (`../shell`): docked,
 * in the hover peek, and as the sheet on a phone width, which a pick closes.
 */
export function Sidebar(props: SidebarProps) {
  const firstRun = props.projects.length === 0;
  const { setOpenMobile } = useSidebar();
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
      <button
        type="button"
        className={`ib-nav${props.page === 'inbox' && props.projectId === null ? ' ib-on' : ''}`}
        onClick={pick(props.onInbox)}
        aria-current={props.page === 'inbox' && props.projectId === null ? 'page' : undefined}
      >
        <Icon name="inbox" />
        Inbox
        {!firstRun && props.inboxCount > 0 && <span className="ib-n">{props.inboxCount}</span>}
      </button>
      <button
        type="button"
        className={`ib-nav${props.page === 'decisions' ? ' ib-on' : ''}`}
        onClick={pick(props.onDecisions)}
        disabled={firstRun}
        aria-current={props.page === 'decisions' ? 'page' : undefined}
      >
        <Icon name="diamond" />
        Decisions
        {props.decisionsCount > 0 && <span className="ib-n">{props.decisionsCount}</span>}
      </button>
      <div className="ib-side-label">Projects</div>
      <div className="ib-projs">
        {firstRun ? (
          <div className="ib-side-empty">Projects appear here when an agent writes from one.</div>
        ) : (
          props.projects.map((project) => {
            const n = props.projectCounts.get(project.id) ?? 0;
            const on = props.page === 'inbox' && props.projectId === project.id;
            return (
              <button
                key={project.id}
                type="button"
                className={`ib-proj${n === 0 ? ' ib-proj-quiet' : ''}${on ? ' ib-on' : ''}`}
                onClick={pick(() => props.onProject(project.id))}
                aria-current={on ? 'page' : undefined}
                title={project.root}
              >
                <span className="ib-name">{project.name}</span>
                {n > 0 && <span className="ib-n">{n}</span>}
              </button>
            );
          })
        )}
      </div>
      <div className="ib-side-foot">
        {props.soundNeedsClick && (
          // The click itself is what allows sound (sound.ts listens for the first one anywhere in the tab).
          <button type="button" className="ib-sound-hint" data-sound-hint="">
            <Icon name="clickHere" />
            Click to turn on sound
          </button>
        )}
        <UpdateButton
          update={props.update}
          restarting={props.restarting}
          updated={props.updated}
          onPress={pick(props.onUpdate)}
          onWhatsNew={(version) => pick(() => props.onWhatsNew(version))()}
        />
        <CopyConnectPrompt mcpCommand={props.mcpCommand ?? null} />
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

/** How long the row reads "Copied" before it goes back to its name. */
export const CONNECT_COPIED_MS = 2000;
/** A failed copy stays on screen a little longer, so it is read. */
export const CONNECT_COPY_FAILED_MS = 4000;
export const CONNECT_COPIED_ANNOUNCEMENT = 'Connect prompt copied.';
export const CONNECT_COPY_FAILED_ANNOUNCEMENT = "Couldn't copy the connect prompt.";

/**
 * "Copy connect prompt" (owner approval 2026-10-13, design record
 * `inbox-sidebar-connect-prompt`): one plain row above Settings that copies
 * the prompt an agent on this computer needs to connect itself
 * (connectPrompt.ts). Only a copy button: no preview, no tooltip, no
 * shortcut. The row says "Copied" for 2 s (or "Couldn't copy"), focus stays
 * on it, and a polite live region says the same. Not navigation, so the
 * phone sheet stays open to show it. Shown everywhere, the tailnet included.
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
        className="ib-nav ib-cp"
        data-connect-prompt={state}
        onClick={() => void copy()}
      >
        <Icon name={state === 'copied' ? 'check' : state === 'failed' ? 'warn' : 'copy'} />
        <span className="ib-cp-l">{state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy connect prompt'}</span>
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
    <button type="button" className="ib-theme-tg" aria-label={label} title={label} data-theme-toggle={shown} onClick={flip}>
      <Icon name={next === 'light' ? 'sun' : 'moon'} />
    </button>
  );
}
