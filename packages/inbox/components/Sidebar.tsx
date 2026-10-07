import type { ProjectFolder } from '../api';
import { Icon } from '../icons';
import { TaterMark } from './TaterMark';

export interface SidebarProps {
  page: 'inbox' | 'settings' | 'decisions';
  projectId: string | null;
  /** Rows waiting on the person, all projects. */
  inboxCount: number;
  /** Questions that record a decision once answered and sent, all projects. */
  decisionsCount: number;
  projects: readonly ProjectFolder[];
  /** Rows waiting on the person, per project id. */
  projectCounts: ReadonlyMap<string, number>;
  /** A newer binary is on disk: "A new version is ready, Restart". */
  updateReady: boolean;
  restarting: boolean;
  onInbox: () => void;
  onProject: (projectId: string) => void;
  onSettings: () => void;
  onDecisions: () => void;
  onRestart: () => void;
}

export function Sidebar(props: SidebarProps) {
  const firstRun = props.projects.length === 0;
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
        onClick={props.onInbox}
        aria-current={props.page === 'inbox' && props.projectId === null ? 'page' : undefined}
      >
        <Icon name="inbox" />
        Inbox
        {!firstRun && props.inboxCount > 0 && <span className="ib-n">{props.inboxCount}</span>}
      </button>
      <button
        type="button"
        className={`ib-nav${props.page === 'decisions' ? ' ib-on' : ''}`}
        onClick={props.onDecisions}
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
                className={`ib-proj${n === 0 ? ' ib-q' : ''}${on ? ' ib-on' : ''}`}
                onClick={() => props.onProject(project.id)}
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
        {props.updateReady && (
          <div className="ib-restart" role="status">
            <Icon name="restart" size={15} />
            A new version is ready
            <b>
              <button type="button" onClick={props.onRestart} disabled={props.restarting}>
                {props.restarting ? 'Restarting' : 'Restart'}
              </button>
            </b>
          </div>
        )}
        <button
          type="button"
          className={`ib-nav${props.page === 'settings' ? ' ib-on' : ''}`}
          onClick={props.onSettings}
          aria-current={props.page === 'settings' ? 'page' : undefined}
        >
          <Icon name="settings" />
          Settings
        </button>
      </div>
    </aside>
  );
}
