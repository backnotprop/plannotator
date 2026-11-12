import { useEffect, useState } from 'react';
import { inboxApi } from '../api';
import { openComposer } from '../compose/openComposer';
import { keepAgentFace, type AgentFaceRef } from './agentFaces';
import { ANIMATE_THREAD_NAME, animatePrompt } from './animatePrompt';
import { isOwnFace, type AgentFace } from './faceChoices';
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

function useAnimatedOriginals(): ReadonlyMap<string, string> {
  const icons = useOwnIcons();
  const key = (icons ?? []).map((icon) => icon.id).join();
  const [originals, setOriginals] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let live = true;
    inboxApi
      .iconAnimateResults()
      .then((answer) => {
        const list = Array.isArray(answer.results) ? (answer.results as { icon?: unknown; result?: unknown }[]) : [];
        if (live) setOriginals(new Map(list.flatMap((r) => (typeof r.icon === 'string' && typeof r.result === 'string' ? [[r.result, r.icon] as const] : []))));
      })
      .catch(() => {}); // An Inbox from before "Animate it", or offline: no way back until a read answers.
    return () => {
      live = false;
    };
  }, [key]);
  return originals;
}

export function AnimateIt({ agent, face, onDone }: { agent: AgentFaceRef; face: AgentFace; onDone: () => void }) {
  const originals = useAnimatedOriginals();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = isOwnFace(face) ? face.slice(4) : null;
  if (!current) return null;
  const original = originals.get(current);
  const back = original && ownFaceShows(`own:${original}`) ? original : null;

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const ref = typeof agent === 'string' ? { id: agent, session: agent, continues: [] as string[] } : agent;
      const sessions = [...new Set([ref.session, ...(ref.continues ?? [])].filter((id): id is string => !!id && id !== ref.id))];
      const [picture, answer] = await within(
        Promise.all([
          fetch(ownIconSrc(current, false)).then((r) => {
            if (!r.ok) throw new Error(String(r.status));
            return r.blob();
          }),
          inboxApi.askIconAnimate({ icon: current, agent: ref.id, sessions }),
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
      <img className="ib-agi-anim-pic" src={ownIconSrc(current, true)} alt="" draggable={false} />
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
            keepAgentFace(agent, `own:${back}`);
            onDone();
          }}
        >
          <img src={ownIconSrc(back, true)} alt="" draggable={false} />
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
