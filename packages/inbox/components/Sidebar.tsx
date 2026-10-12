import type { InboxHealth } from '@plannotator/core/inbox-types';
import type { ProjectFolder } from '../api';
import { Icon } from '../icons';
import { useSidebar } from '../shell/sidebar';
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
        <button
          type="button"
          className={`ib-nav${props.page === 'settings' ? ' ib-on' : ''}`}
          onClick={pick(props.onSettings)}
          aria-current={props.page === 'settings' ? 'page' : undefined}
        >
          <Icon name="settings" />
          Settings
        </button>
      </div>
    </aside>
  );
}
