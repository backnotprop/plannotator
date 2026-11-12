import { useEffect, useState } from 'react';
import { inboxApi } from '../api';
import { openComposer } from '../compose/openComposer';
import { keepAgentFace, type AgentFaceRef } from './agentFaces';
import { ANIMATE_THREAD_NAME, animatePrompt } from './animatePrompt';
import type { FaceSources } from './FaceFan';
import { useAgentFaceSources } from './faceArtLoad';
import { isAgentFace, isOwnFace, type AgentFace } from './faceChoices';
import { isSetFace, setFaceParts, setIconSrc, setLookOf } from './iconSets';
import { ownFaceShows, ownIconSrc, useOwnIcons } from './ownIcons';

export const ANIMATE_WORDS = {
  button: 'Animate it',
  line: 'Asks an agent, in a new thread, to animate this picture. What it sends back becomes this icon, and the original stays one click away.',
  done: 'An agent animated this picture.',
  undo: 'Use the original',
  failed: 'Couldn’t reach the Inbox. Nothing was sent; try again.',
} as const;

/** A step on a poor link never spins for ever: past this it says so, and the button is back. */
const STEP_MS = 20_000;
const within = <T,>(work: Promise<T>): Promise<T> => Promise.race([work, new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), STEP_MS))]);
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/** Picture handed back → the face it replaced, re-read whenever the pictures change (a hand-back adds one). */
function useAnimatedOriginals(): ReadonlyMap<string, AgentFace> {
  const icons = useOwnIcons();
  const key = (icons ?? []).map((icon) => icon.id).join();
  const [originals, setOriginals] = useState<ReadonlyMap<string, AgentFace>>(new Map());
  useEffect(() => {
    let live = true;
    inboxApi
      .iconAnimateResults()
      .then((answer) => {
        const list = Array.isArray(answer.results) ? (answer.results as { icon?: unknown; result?: unknown }[]) : [];
        // `icon` is an uploaded picture's hash, or the face itself (a set's icon, one of ours).
        const pairs = list.flatMap((r) => {
          if (typeof r.result !== 'string' || typeof r.icon !== 'string') return [];
          const face = /^[0-9a-f]{64}$/.test(r.icon) ? `own:${r.icon}` : r.icon;
          return isAgentFace(face) ? [[r.result, face] as const] : [];
        });
        if (live) setOriginals(new Map(pairs));
      })
      .catch(() => {
        // An Inbox from before "Animate it", or offline: no way back is offered until a read answers.
      });
    return () => {
      live = false;
    };
  }, [key]);
  return originals;
}

/**
 * The picture an agent is handed for a face, and the id the request names it by (an uploaded picture's hash, else the
 * face). Null for the agent's own mark (the brand's, already a moving rig) and Transparent (a picture per theme).
 */
export function animateSource(face: AgentFace, ours: FaceSources | null): { icon: string; src: string } | null {
  if (isOwnFace(face)) return { icon: face.slice(4), src: ownIconSrc(face, false) };
  if (isSetFace(face)) {
    const { set, icon } = setFaceParts(face);
    return { icon: face, src: setIconSrc(set, icon) };
  }
  if (face === 'agent' || face === 'transparent') return null;
  const src = ours?.[face];
  return typeof src === 'string' ? { icon: face, src } : null;
}

/** The original's still, for "Use the original" (none for a one-colour set's icon: an image cannot take the text colour). */
function originalStill(face: AgentFace, ours: FaceSources | null): string | null {
  if (isOwnFace(face)) return ownIconSrc(face, true);
  if (isSetFace(face)) return setLookOf(setFaceParts(face).set)?.mono ? null : animateSource(face, ours)?.src ?? null;
  return animateSource(face, ours)?.src ?? null;
}

const isOurs = (face: AgentFace) => !isOwnFace(face) && !isSetFace(face) && face !== 'agent';

/**
 * "Animate it", under the agent icon dialog's head (AgentIconDialog.tsx), whichever place is open, for the icon the
 * agent shows now: its own picture, a set's icon or one of our faces. One press keeps a request with the Inbox
 * (packages/server/inbox-icon-animate.ts) and opens New message filled in (compose/openComposer.ts): the words
 * (animatePrompt.ts), the picture attached, To open on the running agents and "New <agent> session". The person sends
 * it. The agent's hand-back changes this icon in every window by itself; a picture an agent handed back offers "Use the
 * original" in its place.
 */
export function AnimateIt({ agent, face, onDone }: { agent: AgentFaceRef; face: AgentFace; onDone: () => void }) {
  const originals = useAnimatedOriginals();
  const ours = useAgentFaceSources(isOurs(face));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const source = animateSource(face, ours);
  const original = isOwnFace(face) ? originals.get(face.slice(4)) : undefined;
  const back = original && (!isOwnFace(original) || ownFaceShows(original)) ? original : null;
  if (!source && !back) return null;
  const backStill = back ? originalStill(back, ours) : null;

  const start = async () => {
    if (busy || !source) return;
    setBusy(true);
    setFailed(false);
    try {
      const ref = typeof agent === 'string' ? { id: agent, session: agent, continues: [] as string[] } : agent;
      const sessions = [...new Set([ref.session, ...(ref.continues ?? [])].filter((id): id is string => !!id && id !== ref.id))];
      const [picture, answer] = await within(
        Promise.all([
          fetch(source.src).then((r) => {
            if (!r.ok) throw new Error(String(r.status));
            return r.blob();
          }),
          inboxApi.askIconAnimate({ icon: source.icon, agent: ref.id, sessions }),
        ]),
      );
      if (typeof answer.request !== 'string') throw new Error('no request');
      const file = new File([picture], `agent-icon.${EXT[picture.type] ?? 'png'}`, { type: picture.type });
      onDone();
      openComposer({ subject: ANIMATE_THREAD_NAME, body: animatePrompt(answer.request), files: [file], to: 'pick' });
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <div className="ib-agi-anim" data-animate-it="">
      <div className="ib-agi-anim-t">
        <span className="ib-agi-anim-l">{back ? ANIMATE_WORDS.done : ANIMATE_WORDS.line}</span>
        {failed && (
          <span className="ib-agi-anim-e" role="status">
            {ANIMATE_WORDS.failed}
          </span>
        )}
      </div>
      {back ? (
        <button
          type="button"
          className="ib-btn ib-sm ib-agi-anim-b"
          data-animate-undo=""
          onClick={() => {
            keepAgentFace(agent, back);
            onDone();
          }}
        >
          {backStill && <img src={backStill} alt="" draggable={false} />}
          {ANIMATE_WORDS.undo}
        </button>
      ) : (
        <button type="button" className="ib-btn ib-sm ib-agi-anim-b" data-animate-go="" aria-busy={busy || undefined} disabled={busy} onClick={() => void start()}>
          {ANIMATE_WORDS.button}
        </button>
      )}
    </div>
  );
}
