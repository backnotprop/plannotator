import { useEffect, useId, useRef, useState } from 'react';
import { HostMark, Icon } from '../icons';
import { Modal } from '../components/Updates';
import type { AgentFaceRef } from './agentFaces';
import type { AgentFace } from './faceChoices';
import { OWN_LABEL, SETS_LABEL } from './FaceFan';
import { OwnIconsBody } from './OwnIconsBody';
import { SetsBody } from './SetsBody';

export type AgentIconPlace = 'own' | 'sets';

/** Where the dialog is a sheet from the bottom (iconDialog.css): its place is the sheet's, never pinned. */
const SHEET = '(max-width: 767px), (max-height: 500px) and (max-width: 1023px) and (pointer: coarse)';
/** The dialog's full height (Sets), as iconDialog.css draws it, and the room it keeps from the window's edges. */
const FULL = 640;
const EDGE = 24;

/**
 * The top edge chosen once, as the dialog opens: centred for the place it opens on, raised only as far as Sets' full
 * height needs to fit below it. Switching between "Your own…" and Sets then moves only its bottom edge. A resize
 * chooses again. Not on a phone, where it is a sheet.
 */
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * The agent icon dialog: "Your own…" or "Sets", chosen in the face picker (FaceFan.tsx), opened in the middle of the
 * window in the Inbox's own dialog (`Modal`, components/Updates.tsx: a native modal, Escape and a click outside close
 * it, focus goes back to the agent's face). Its head names the agent and shows the icon it has now; a switch moves
 * between the two places. Picking an icon applies it at once and closes the dialog. On a phone it is a full-height
 * sheet. No shortcut: its keys are the dialog's own. `shared`: a linked machine's agent (AgentMark.tsx), Sets alone
 * and only its built-in sets, with no switch.
 */
export function AgentIconDialog({ place, agent, host, name, face, shared = false, onClose }: { place: AgentIconPlace; agent: AgentFaceRef; host: string | null; name: string; face: AgentFace; shared?: boolean; onClose: () => void }) {
  const [on, setOn] = useState<AgentIconPlace>(shared ? 'sets' : place);
  const uid = useId();
  const agentId = typeof agent === 'string' ? agent : agent.id;
  const places: { id: AgentIconPlace; label: string }[] = [
    { id: 'own', label: OWN_LABEL },
    { id: 'sets', label: SETS_LABEL },
  ];
  // On a touch screen the search is not focused as the dialog opens: its keyboard would come up over the icons.
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
        {!shared && (
          <div className="ib-seg" role="tablist" aria-labelledby={`${uid}-t`}>
            {places.map((p) => (
              <button key={p.id} type="button" role="tab" className="ib-seg-o" data-on={on === p.id ? '' : undefined} aria-selected={on === p.id} data-agi-place={p.id} onClick={() => setOn(p.id)}>
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
        {on === 'own' ? <OwnIconsBody agent={agent} face={face} onDone={onClose} /> : <SetsBody agent={agent} face={face} builtInOnly={shared} onDone={onClose} />}
      </div>
    </Modal>
  );
}
