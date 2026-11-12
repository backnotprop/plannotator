import { useId, useState } from 'react';
import { HostMark, Icon } from '../icons';
import { Modal } from '../components/Updates';
import { agentFaceOf, keepAgentFace, type AgentFaceRef } from './agentFaces';
import { isOwnFace, type AgentFace } from './faceChoices';
import { ANIMATE_WORDS, AnimateIt, animateSource, startAnimate } from './AnimateIt';
import { iconFlow, showToastFromAnywhere } from './iconFlowDev';
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
 * between the two places. Under the head, in both places, "Animate it" for that icon (AnimateIt.tsx). Picking an icon
 * applies it at once and closes the dialog. One size in both places, so a switch moves no edge; on a phone it is a
 * full-height sheet. No shortcut: its keys are the dialog's own.
 */
export function AgentIconDialog({ place, agent, host, name, face, onClose, showPicked = false }: { place: AgentIconPlace; agent: AgentFaceRef; host: string | null; name: string; face: AgentFace; onClose: () => void; showPicked?: boolean }) {
  const [on, setOn] = useState<AgentIconPlace>(place);
  const uid = useId();
  const agentId = typeof agent === 'string' ? agent : agent.id;
  const places: { id: AgentIconPlace; label: string }[] = [
    { id: 'own', label: OWN_LABEL },
    { id: 'sets', label: SETS_LABEL },
  ];
  // On a touch screen the search is not focused as the dialog opens: its keyboard would come up over the icons.
  const [touch] = useState(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  const initialFocus = touch ? '.ib-agi-body' : showPicked && iconFlow() === 'selected' && (isOwnFace(face) || isSetFace(face)) ? '.ib-agi-back' : on === 'sets' ? '.am-sets-q' : '.ib-agi-drop';
  // Exploration (agents/iconFlowDev.ts): what a pick does. `close`: today. `stay`: the dialog stays, its head and
  // "Animate it" follow the pick. `toast`: it closes and a toast offers "Animate it" and Undo. `beside`: it stays, and
  // "Animate it" sits under the picked icon in the grid.
  const [flow] = useState(iconFlow);
  // `selected`: a pick shows that icon's own page (SelectedIcon.tsx); opened from the agent's mark, the dialog starts there.
  const pickedFace = isOwnFace(face) || isSetFace(face);
  const [view, setView] = useState<'grid' | 'selected'>(flow === 'selected' && showPicked && pickedFace ? 'selected' : 'grid');
  // An icon picked in a grid, shown on its page and not kept until "Use this icon" or "Animate it".
  const [preview, setPreview] = useState<AgentFace | null>(null);
  const toGrid = () => {
    setPreview(null);
    setView('grid');
  };
  const onPick =
    flow === 'selected'
      ? (next: AgentFace) => {
          setOn(isOwnFace(next) ? 'own' : 'sets');
          setPreview(next);
          setView('selected');
        }
      : undefined;
  const before = face;
  const picked = () => {
    if (flow === 'stay' || flow === 'beside') return;
    onClose();
    if (flow !== 'toast') return;
    const now = agentFaceOf(agentId);
    const source = animateSource(now, null);
    if (!source || now === before) return;
    showToastFromAnywhere({
      icon: 'check',
      lead: 'Icon changed',
      detail: name,
      action: {
        label: ANIMATE_WORDS.button,
        onPress: () =>
          void startAnimate(agent, source).then((ok) => {
            if (!ok) showToastFromAnywhere({ icon: 'warn', lead: ANIMATE_WORDS.failed, wrap: true });
          }),
      },
      onUndo: () => keepAgentFace(agent, before),
    });
  };
  const keepOpen = flow === 'stay' || flow === 'beside';
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
      {!(flow === 'beside' && on === 'sets') && flow !== 'selected' && <AnimateIt agent={agent} face={face} onDone={onClose} onBack={keepOpen ? () => {} : onClose} />}
      <div className="ib-agi-body" role="tabpanel" tabIndex={-1}>
        {view === 'selected' && (preview || pickedFace) ? (
          <SelectedIcon agent={agent} host={host} name={name} face={preview ?? face} previewing={!!preview} onBack={toGrid} onDone={onClose} />
        ) : on === 'own' ? (
          <OwnIconsBody agent={agent} face={face} onDone={picked} onPick={onPick} />
        ) : (
          <SetsBody agent={agent} face={face} onDone={picked} onPick={onPick} pin={flow === 'beside' ? <AnimateIt agent={agent} face={face} onDone={onClose} bare /> : undefined} />
        )}
      </div>
    </Modal>
  );
}
