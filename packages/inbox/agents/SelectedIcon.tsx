import { useEffect, useRef } from 'react';
import { FaceOfMark, Icon } from '../icons';
import { keepAgentFace, type AgentFaceRef } from './agentFaces';
import { AnimateIt } from './AnimateIt';
import type { AgentFace } from './faceChoices';
import { OWN_LABEL } from './FaceFan';
import { isSetFace, setFaceParts, useIconSets, useSetListing } from './iconSets';
import { setNumber } from './SetsBody';

export const USE_THIS_ICON = 'Use this icon';

/**
 * Exploration ("selected", agents/iconFlowDev.ts): the agent icon dialog's page for one icon. `previewing`: just
 * picked in a grid and not kept yet: the agent still shows its old icon everywhere. "Use this icon" keeps it and
 * closes; "Animate it" keeps it and asks for the animation; the back control (to the grid it came from) and Close
 * leave with nothing changed. Not previewing: the icon the agent shows now, reopened later, with "Animate it" (or
 * "Use the original" for an animated one).
 */
export function SelectedIcon({ agent, host, name, face, previewing, onBack, onDone }: { agent: AgentFaceRef; host: string | null; name: string; face: AgentFace; previewing: boolean; onBack: () => void; onDone: () => void }) {
  const sets = useIconSets();
  const parts = isSetFace(face) ? setFaceParts(face) : null;
  const listing = useSetListing(parts?.set ?? null);
  const set = parts ? sets?.find((s) => s.id === parts.set) : null;
  const icon = parts ? listing?.icons.find((i) => i.id === parts.icon) : null;
  const back = parts ? (set?.name ?? '') : OWN_LABEL;
  const caption = icon && set ? `${icon.name} · ${setNumber(icon.n, set.count)}` : null;
  const keep = () => keepAgentFace(agent, face);

  // Focus: "Use this icon" on a preview (Enter keeps it), else "Animate it". After the dialog's own first focus (Modal).
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      const go = el.querySelector<HTMLButtonElement>('[data-use-icon], [data-animate-go], [data-animate-undo]') ?? el.querySelector<HTMLButtonElement>('.ib-agi-back');
      go?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [face, previewing]);

  return (
    <div className="ib-agi-sel" ref={root} data-selected-icon={face} data-previewing={previewing ? '' : undefined}>
      <button type="button" className="ib-btn ib-ghost ib-sm ib-agi-back" onClick={onBack}>
        <Icon name="chevL" />
        {back}
      </button>
      <div className="ib-agi-sel-mid">
        <span className="ib-agi-sel-big">
          <FaceOfMark host={host} face={face} big />
        </span>
        {caption && <span className="ib-agi-sel-cap">{caption}</span>}
        <span className="ib-agi-sel-sizes" aria-hidden="true">
          <span className="ib-agi-sel-at" data-size="24">
            <FaceOfMark host={host} face={face} big />
            <span dir="auto">{name}</span>
          </span>
          <span className="ib-agi-sel-at" data-size="16">
            <FaceOfMark host={host} face={face} />
            <span dir="auto">{name}</span>
          </span>
        </span>
        {previewing && (
          <button
            type="button"
            className="ib-btn ib-pri ib-agi-use"
            data-use-icon=""
            onClick={() => {
              keep();
              onDone();
            }}
          >
            {USE_THIS_ICON}
          </button>
        )}
        <div className="ib-agi-sel-anim">
          <AnimateIt agent={agent} face={face} onDone={onDone} onBack={() => {}} beforeStart={previewing ? keep : undefined} />
        </div>
      </div>
    </div>
  );
}
