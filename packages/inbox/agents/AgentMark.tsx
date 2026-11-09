import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { HostMark } from '../icons';
import { keepAgentFace, useAgentFace } from './agentFaces';
import { agentFaceArtReady, agentRigOf, mountAgentMark, nextAgentFace, setAgentFaceArt, setAgentMarkState, showAgentFace, unmountAgentMark, type AgentMood } from './motion';

let artLoad: Promise<void> | null = null;
/** Our faces' pictures (faceArt.ts), fetched once, on the first click or for a face kept from before. */
export function loadAgentFaceArt(): Promise<void> {
  artLoad ??= import('./faceArt').then(
    (mod) => setAgentFaceArt(mod.AGENT_FACE_ART),
    (cause: unknown) => {
      artLoad = null;
      throw cause;
    },
  );
  return artLoad;
}

/**
 * An agent's animated mark (motion.ts), 24 px, with no tile. A click on it shows the next face of the cycle (the
 * agent, Glass, Yellow, Transparent, Face) and never reaches the row; the face is kept for that agent until the next
 * click (agentFaces.ts). A host with no rig shows its plain mark, still, and cycles the same way. Decorative: the
 * row's words name the agent, and the cycle is a pointer's play, never a keyboard stop.
 */
export function AgentMark({ id, host, state }: { id: string; host: string | null; state: AgentMood }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [stillTile, setStillTile] = useState<HTMLElement | null>(null);
  const face = useAgentFace(id);
  const rig = agentRigOf(host);
  const clicked = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tile = mountAgentMark(el, { rig, state: stateRef.current, face: 'agent', size: 24 });
    setStillTile(rig ? null : tile);
    return () => {
      setStillTile(null);
      unmountAgentMark(el);
    };
  }, [rig]);
  useEffect(() => {
    if (ref.current) setAgentMarkState(ref.current, state);
  }, [state, rig]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const withMotion = clicked.current;
    if (face === 'agent' || agentFaceArtReady()) {
      showAgentFace(el, face, withMotion);
      return;
    }
    let live = true;
    loadAgentFaceArt().then(
      () => {
        if (live) showAgentFace(el, face, withMotion);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [face, rig]);
  const cycle = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    clicked.current = true;
    keepAgentFace(id, nextAgentFace(face));
  };
  return (
    <>
      <span ref={ref} className="am" aria-hidden="true" data-agent-mark={id} data-rig={rig ?? 'still'} onClick={cycle} />
      {stillTile && createPortal(<HostMark host={host} />, stillTile)}
    </>
  );
}
