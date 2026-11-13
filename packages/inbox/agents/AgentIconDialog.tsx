import { useId, useState } from 'react';
import { HostMark, Icon } from '../icons';
import { Modal } from '../components/Updates';
import type { AgentFaceRef } from './agentFaces';
import { isOwnFace, type AgentFace } from './faceChoices';
import { OWN_LABEL, SETS_LABEL } from './FaceFan';
import { OwnIconsBody } from './OwnIconsBody';
import { SetsBody } from './SetsBody';
import { SelectedIcon } from './SelectedIcon';
import { isSetFace } from './iconSets';

export type AgentIconPlace = 'own' | 'sets';

/**
 * The agent icon dialog: "Your own…" or "Sets", chosen in the face picker (FaceFan.tsx), opened in the middle of the
 * window in the Inbox's own dialog (`Modal`, components/Updates.tsx: a native modal, Escape and a click outside close
 * it, focus goes back to the agent's face). Its head names the agent and shows the icon it has now; a switch moves
 * between the two places. Picking an icon (or uploading one) shows its page (SelectedIcon.tsx) and keeps nothing until
 * "Use this icon" or "Animate it". Opened on the place of the icon the agent shows, it starts on that icon's page. One
 * size in both places, so a switch moves no edge; on a phone it is a full-height sheet. No shortcut: its keys are the
 * dialog's own.
 */
export function AgentIconDialog({ place, agent, host, name, face, onClose }: { place: AgentIconPlace; agent: AgentFaceRef; host: string | null; name: string; face: AgentFace; onClose: () => void }) {
  const [on, setOn] = useState<AgentIconPlace>(place);
  const uid = useId();
  const agentId = typeof agent === 'string' ? agent : agent.id;
  const places: { id: AgentIconPlace; label: string }[] = [
    { id: 'own', label: OWN_LABEL },
    { id: 'sets', label: SETS_LABEL },
  ];
  const inUse = place === 'own' ? isOwnFace(face) : isSetFace(face);
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
        <span className="ib-agi-mark" data-agent-icon-now={agentId}>
          <HostMark host={host} agent={agentId} big />
        </span>
        <h2 id={`${uid}-t`} dir="auto">
          {name}
        </h2>
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
        <button type="button" className="ib-btn ib-ghost ib-icon ib-agi-x" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="ib-agi-body" role="tabpanel" tabIndex={-1}>
        {page && (preview || inUse) ? (
          <SelectedIcon agent={agent} host={host} name={name} face={preview ?? face} previewing={!!preview} onBack={toGrid} onDone={onClose} />
        ) : on === 'own' ? (
          <OwnIconsBody face={face} onPick={onPick} />
        ) : (
          <SetsBody face={face} onPick={onPick} />
        )}
      </div>
    </Modal>
  );
}
