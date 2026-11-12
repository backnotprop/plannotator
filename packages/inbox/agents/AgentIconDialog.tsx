import { useEffect, useId, useRef, useState } from 'react';
import { HostMark, Icon } from '../icons';
import { Modal } from '../components/Updates';
import type { AgentFaceRef } from './agentFaces';
import type { AgentFace } from './faceChoices';
import { OWN_LABEL, SETS_LABEL } from './FaceFan';
import { OwnIconsBody } from './OwnIconsBody';
import { SetsBody } from './SetsBody';

export type AgentIconPlace = 'own' | 'sets';

const SHEET = '(max-width: 767px), (max-height: 500px) and (max-width: 1023px) and (pointer: coarse)';
const FULL = 640;
const EDGE = 24;

function usePinnedTop(dialog: () => HTMLDialogElement | null | undefined): void {
  useEffect(() => {
    const el = dialog();
    if (!el || typeof matchMedia !== 'function') return;
    const pin = () => {
      el.style.removeProperty('--agi-top');
      if (matchMedia(SHEET).matches) return;
      const full = Math.min(FULL, innerHeight - 2 * EDGE);
      el.style.setProperty('--agi-top', `${Math.max(EDGE, Math.min(el.offsetTop, innerHeight - EDGE - full))}px`);
    };
    pin();
    addEventListener('resize', pin);
    return () => removeEventListener('resize', pin);
  }, []);
}

export function AgentIconDialog({ place, agent, host, name, face, onClose }: { place: AgentIconPlace; agent: AgentFaceRef; host: string | null; name: string; face: AgentFace; onClose: () => void }) {
  const [on, setOn] = useState<AgentIconPlace>(place);
  const uid = useId();
  const agentId = typeof agent === 'string' ? agent : agent.id;
  const places: { id: AgentIconPlace; label: string }[] = [
    { id: 'own', label: OWN_LABEL },
    { id: 'sets', label: SETS_LABEL },
  ];
  const [touch] = useState(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  const head = useRef<HTMLDivElement>(null);
  usePinnedTop(() => head.current?.closest('dialog'));
  const initialFocus = touch ? '.ib-agi-body' : on === 'sets' ? '.am-sets-q' : '.ib-agi-drop';
  return (
    <Modal labelledBy={`${uid}-t`} testId="agent-icon" onClose={onClose} ownKeys initialFocus={initialFocus} className="ib-agi">
      <div ref={head} className="ib-dlg-head ib-agi-head">
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
