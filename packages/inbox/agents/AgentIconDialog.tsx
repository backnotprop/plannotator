import { useId, useState } from 'react';
import { HostMark, Icon } from '../icons';
import { Modal } from '../components/Updates';
import { ProjectMark } from '../letterMarks';
import type { AgentFaceRef } from './agentFaces';
import { isOwnFace, type AgentFace } from './faceChoices';
import { OWN_LABEL, SETS_LABEL } from './FaceFan';
import { OwnIconsBody } from './OwnIconsBody';
import { SetsBody } from './SetsBody';
import { SelectedIcon } from './SelectedIcon';
import { isSetFace } from './iconSets';
import { PROJECT_NO_FACE, type IconTarget } from './iconTarget';

export type AgentIconPlace = 'own' | 'sets';

/**
 * The agent icon dialog: "Your own…" or "Sets", chosen in the face picker (FaceFan.tsx), opened in the middle of the
 * window in the Inbox's own dialog (`Modal`, components/Updates.tsx: a native modal, Escape and a click outside close
 * it, focus goes back to the agent's face). Its head names the agent and shows the icon it has now; a switch moves
 * between the two places. Picking an icon (or uploading one) shows its page (SelectedIcon.tsx) and keeps nothing until
 * "Use this icon" or "Animate it". Opened on the place of the icon the agent shows, it starts on that icon's page. One
 * size in both places, so a switch moves no edge; on a phone it is a full-height sheet. No shortcut: its keys are the
 * dialog's own. `shared`: a linked machine's agent (AgentMark.tsx): Sets alone, only its built-in sets, no switch,
 * opened on the grid, and its pages without "Animate it".
 */
export function AgentIconDialog({ place, agent, host, name, face, shared = false, onClose }: { place: AgentIconPlace; agent: AgentFaceRef; host: string | null; name: string; face: AgentFace; shared?: boolean; onClose: () => void }) {
  return <IconDialog place={place} target={{ kind: 'agent', agent }} host={host} name={name} face={face} shared={shared} onClose={onClose} />;
}

/**
 * The same dialog for a project's picture (its letter mark): opened from the project mark's picker or the project ⋯
 * menu's Set picture…, on the grid of either place. Use this icon keeps the icon's bytes as the project's picture
 * (iconTarget.ts), on the Inbox that has the project, a linked machine's too.
 */
export function ProjectIconDialog({ place, project, name, onClose }: { place: AgentIconPlace; project: string; name: string; onClose: () => void }) {
  return <IconDialog place={place} target={{ kind: 'project', project, name }} host={null} name={name} face={PROJECT_NO_FACE} onClose={onClose} />;
}

function IconDialog({ place, target, host, name, face, shared = false, onClose }: { place: AgentIconPlace; target: IconTarget; host: string | null; name: string; face: AgentFace; shared?: boolean; onClose: () => void }) {
  const [on, setOn] = useState<AgentIconPlace>(shared ? 'sets' : place);
  const uid = useId();
  const agentId = target.kind === 'agent' ? (typeof target.agent === 'string' ? target.agent : target.agent.id) : null;
  const places: { id: AgentIconPlace; label: string }[] = [
    { id: 'own', label: OWN_LABEL },
    { id: 'sets', label: SETS_LABEL },
  ];
  const inUse = !shared && target.kind === 'agent' && (place === 'own' ? isOwnFace(face) : isSetFace(face));
  const [page, setPage] = useState(inUse);
  // An icon picked in a grid: shown on its page, not kept.
  const [preview, setPreview] = useState<AgentFace | null>(null);
  const toGrid = () => {
    setPreview(null);
    setPage(false);
  };
  const onPick = (next: AgentFace) => {
    setOn(isOwnFace(next) ? 'own' : 'sets');
    setPreview(next);
    setPage(true);
  };
  // On a touch screen the search is not focused as the dialog opens: its keyboard would come up over the icons.
  const [touch] = useState(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  const initialFocus = touch ? '.ib-agi-body' : inUse ? '.ib-agi-back' : on === 'sets' ? '.am-sets-q' : '.ib-agi-drop';
  return (
    <Modal labelledBy={`${uid}-t`} testId="agent-icon" onClose={onClose} ownKeys initialFocus={initialFocus} className="ib-agi">
      <div className="ib-dlg-head ib-agi-head">
        {target.kind === 'project' ? (
          <span className="ib-agi-mark" data-project-icon-now={target.project}>
            <ProjectMark projectId={target.project} name={target.name} size={24} />
          </span>
        ) : (
          <span className="ib-agi-mark" data-agent-icon-now={agentId}>
            <HostMark host={host} agent={agentId} big />
          </span>
        )}
        <h2 id={`${uid}-t`} dir="auto">
          {name}
        </h2>
        {!shared && (
          <div className="ib-seg" role="tablist" aria-labelledby={`${uid}-t`}>
            {places.map((p) => (
              <button key={p.id} type="button" role="tab" className="ib-seg-o" data-on={on === p.id ? '' : undefined} aria-selected={on === p.id} data-agi-place={p.id} onClick={() => {
                  setOn(p.id);
                  toGrid();
                }}>
                {p.label}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="ib-btn ib-ghost ib-icon ib-agi-x" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="ib-agi-body" role={shared ? undefined : 'tabpanel'} tabIndex={-1}>
        {page && (preview || inUse) ? (
          <SelectedIcon target={target} host={host} name={name} face={preview ?? face} previewing={!!preview} shared={shared} onBack={toGrid} onDone={onClose} />
        ) : on === 'own' ? (
          <OwnIconsBody face={face} onPick={onPick} />
        ) : (
          <SetsBody face={face} builtInOnly={shared} onPick={onPick} />
        )}
      </div>
    </Modal>
  );
}
