import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { HostMark } from '../icons';
import { keepAgentFace, useAgentFace } from './agentFaces';
import { agentFaceArtReady, agentRigOf, mountAgentMark, nextAgentFace, setAgentFaceArt, showAgentFace, unmountAgentMark } from './motion';

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
 * An agent's animated mark (motion.ts), 24 px, with no tile: always alive, the same whatever the agent is doing, its
 * own life seeded by the agent's id. A click on it shows the next face of the cycle (the agent, Glass, Yellow,
 * Transparent, Face) and never reaches the row; the face is kept for that agent until the next click (agentFaces.ts).
 * A host with no rig shows its plain mark, moved as a whole, and cycles the same way. Decorative: the row's words name
 * the agent, and the cycle is a pointer's play, never a keyboard stop.
 */
export function AgentMark({ id, host }: { id: string; host: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [plain, setPlain] = useState<HTMLElement | null>(null);
  const face = useAgentFace(id);
  const rig = agentRigOf(host);
  const clicked = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPlain(mountAgentMark(el, { rig, face: 'agent', size: 24, seed: id }));
    return () => {
      setPlain(null);
      unmountAgentMark(el);
    };
  }, [rig, id]);
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
  }, [face, rig, id]);
  const cycle = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    clicked.current = true;
    keepAgentFace(id, nextAgentFace(face));
  };
  return (
    <>
      <span ref={ref} className="am" aria-hidden="true" data-agent-mark={id} data-rig={rig ?? 'plain'} onClick={cycle} />
      {plain && createPortal(<HostMark host={host} />, plain)}
    </>
  );
}
