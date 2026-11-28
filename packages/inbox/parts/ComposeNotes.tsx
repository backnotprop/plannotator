/**
 * New message's notes under Thread (compose/ComposeDialog.tsx): the folder a new session would start in is not there,
 * no agent is running, or the session a draft or message was for has ended. Drawing only: the dialog says which show.
 */
import type { InboxDraftTo } from '@plannotator/core/inbox-types';
import { whenTime } from '../format';
import { Icon } from '../icons';
import { hostLabel } from '../compose/model';

export interface ComposeNotesProps {
  /** A new session's project whose folder is not there: `root` as the person reads it, `unplugged` its drive's name. */
  missing: { agentName: string; projectName: string; root: string; unplugged: string | null; scratch: boolean } | null;
  onPickFolder: () => void;
  /** No agent is running and none can start: in `projectName`, when there is one; a review needs one. */
  none: { projectName: string | null; review: boolean } | null;
  /** The session this draft (`draft`) or message was for, ended; Pick a session while another is live. */
  ended: InboxDraftTo | null;
  draft: boolean;
  onPickSession: (() => void) | null;
}

export function ComposeNotes({ missing, onPickFolder, none, ended, draft, onPickSession }: ComposeNotesProps) {
  return (
    <>
      {missing && (
        <div className="ib-cp-note ib-warn" data-compose-note="folder-missing">
          <Icon name="warn" size={16} />
          <div>
            {missing.unplugged ? (
              <b>
                <bdi>{missing.unplugged}</bdi> isn't connected.
              </b>
            ) : (
              <b>
                <bdi>{missing.root}</bdi> isn't there any more.
              </b>
            )}
            <p>
              {missing.unplugged ? (
                <>
                  Connect it to start {missing.agentName} in <bdi>{missing.projectName}</bdi>, or pick another project. Nothing is sent until you do.
                </>
              ) : (
                <>
                  It was moved or deleted. Pick another project{missing.scratch ? ', or a new scratch folder,' : ''} to start {missing.agentName} in. Nothing is sent until you do.
                </>
              )}
            </p>
            <button type="button" className="ib-btn ib-sm" onClick={onPickFolder} data-compose-pick-folder="">
              Pick a project
            </button>
          </div>
        </div>
      )}
      {none && (
        <div className="ib-cp-note" data-compose-note="none">
          <Icon name="info" size={16} />
          <div>
            <b>No agent is running{none.projectName ? ` in ${none.projectName}` : ''}.</b>
            <p>{none.review ? `A review needs one. Start Claude Code, Pi or OpenCode in the project and it shows up here.` : <>Nothing can be sent until one is. Save it as a draft; it waits under Drafts, and you send it when Claude Code, Pi or OpenCode is running.</>}</p>
          </div>
        </div>
      )}
      {ended && (
        <div className="ib-cp-note ib-warn" data-compose-note="ended">
          <Icon name="warn" size={16} />
          <div>
            <b>The {hostLabel(ended.host)} session this {draft ? 'draft' : 'message'} was for has ended.</b>
            <p>
              {ended.project_name ? `It was in ${ended.project_name}` : 'It'}
              {ended.started_at ? `, started ${whenTime(ended.started_at)}` : ''}. Pick a live session to send it, or keep it as a draft.
            </p>
            {onPickSession && (
              <button type="button" className="ib-btn ib-sm" onClick={onPickSession} data-compose-pick="">
                Pick a session
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
