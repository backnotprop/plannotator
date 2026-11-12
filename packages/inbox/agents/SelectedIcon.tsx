import { useEffect, useRef } from 'react';
import { HostMark, Icon } from '../icons';
import type { AgentFaceRef } from './agentFaces';
import { AnimateIt } from './AnimateIt';
import type { AgentFace } from './faceChoices';
import { OWN_LABEL } from './FaceFan';
import { isSetFace, setFaceParts, useIconSets, useSetListing } from './iconSets';
import { setNumber } from './SetsBody';

/**
 * Exploration ("selected", agents/iconFlowDev.ts): the agent icon dialog's page for the icon just picked. The icon
 * large, then at the sizes the window shows it (the sidebar's 24 px beside the name, a row's 16 px), its set and
 * number, and "Animate it" (or "Use the original" for an animated one). The back control names where it goes: the
 * set's grid, or "Your own…". The icon is already applied, so closing is leaving.
 */
export function SelectedIcon({ agent, host, name, face, onBack, onDone }: { agent: AgentFaceRef; host: string | null; name: string; face: AgentFace; onBack: () => void; onDone: () => void }) {
  const agentId = typeof agent === 'string' ? agent : agent.id;
  const sets = useIconSets();
  const parts = isSetFace(face) ? setFaceParts(face) : null;
  const listing = useSetListing(parts?.set ?? null);
  const set = parts ? sets?.find((s) => s.id === parts.set) : null;
  const icon = parts ? listing?.icons.find((i) => i.id === parts.icon) : null;
  const back = parts ? (set?.name ?? '') : OWN_LABEL;
  const caption = icon && set ? `${icon.name} · ${setNumber(icon.n, set.count)}` : null;

  // Focus goes to "Animate it", the one step left; Escape still leaves and the back control is a Tab away.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // After the dialog's own first focus (Modal), which runs after this.
    const frame = requestAnimationFrame(() => {
      const go = el.querySelector<HTMLButtonElement>('[data-animate-go], [data-animate-undo]') ?? el.querySelector<HTMLButtonElement>('.ib-agi-back');
      go?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [face]);

  return (
    <div className="ib-agi-sel" ref={root} data-selected-icon={face}>
      <button type="button" className="ib-btn ib-ghost ib-sm ib-agi-back" onClick={onBack}>
        <Icon name="chevL" />
        {back}
      </button>
      <div className="ib-agi-sel-mid">
        <span className="ib-agi-sel-big" data-agent-icon-now={agentId}>
          <HostMark host={host} agent={agentId} big />
        </span>
        {caption && <span className="ib-agi-sel-cap">{caption}</span>}
        <span className="ib-agi-sel-sizes" aria-hidden="true">
          <span className="ib-agi-sel-at" data-size="24">
            <HostMark host={host} agent={agentId} big />
            <span dir="auto">{name}</span>
          </span>
          <span className="ib-agi-sel-at" data-size="16">
            <HostMark host={host} agent={agentId} />
            <span dir="auto">{name}</span>
          </span>
        </span>
        <div className="ib-agi-sel-anim">
          <AnimateIt agent={agent} face={face} onDone={onDone} onBack={() => {}} />
        </div>
      </div>
    </div>
  );
}
