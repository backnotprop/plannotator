import { useId, useState } from 'react';
import { HostMark, Icon } from '../icons';
import { Modal } from '../components/Updates';
import type { AgentFaceRef } from './agentFaces';
import type { AgentFace } from './faceChoices';
import { OWN_LABEL, SETS_LABEL } from './FaceFan';
import { OwnIconsBody } from './OwnIconsBody';
import { SetsBody } from './SetsBody';

export type AgentIconPlace = 'own' | 'sets';

/**
 * The agent icon dialog: "Your own…" or "Sets", chosen in the face picker (FaceFan.tsx), opened in the middle of the
 * window in the Inbox's own dialog (`Modal`, components/Updates.tsx: a native modal, Escape and a click outside close
 * it, focus goes back to the agent's face). Its head names the agent and shows the icon it has now; a switch moves
 * between the two places. Picking an icon applies it at once and closes the dialog. On a phone it is a full-height
 * sheet. No shortcut: its keys are the dialog's own.
 */
export function AgentIconDialog({ place, agent, host, name, face, onClose }: { place: AgentIconPlace; agent: AgentFaceRef; host: string | null; name: string; face: AgentFace; onClose: () => void }) {
  const [on, setOn] = useState<AgentIconPlace>(place);
  const uid = useId();
  const agentId = typeof agent === 'string' ? agent : agent.id;
  const places: { id: AgentIconPlace; label: string }[] = [
    { id: 'own', label: OWN_LABEL },
    { id: 'sets', label: SETS_LABEL },
  ];
  // On a touch screen the search is not focused as the dialog opens: its keyboard would come up over the icons.
  const [touch] = useState(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  const initialFocus = touch ? '.ib-agi-body' : on === 'sets' ? '.am-sets-q' : '.ib-agi-drop';
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
            <button key={p.id} type="button" role="tab" className="ib-seg-o" data-on={on === p.id ? '' : undefined} aria-selected={on === p.id} data-agi-place={p.id} onClick={() => setOn(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <button type="button" className="ib-btn ib-ghost ib-icon ib-agi-x" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="ib-agi-body" role="tabpanel" tabIndex={-1}>
        {on === 'own' ? <OwnIconsBody agent={agent} face={face} onDone={onClose} /> : <SetsBody agent={agent} face={face} onDone={onClose} />}
      </div>
    </Modal>
  );
}
