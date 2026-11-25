import { useState } from 'react';
import { openComposer } from '../compose/openComposer';
import { projectFacts, sessionProjectOf, sessionRecentTitles } from '../projectPictures';
import { ANIMATE_WORDS } from './AnimateIt';
import { DRAW_THREAD_NAME, drawPrompt, type DrawSubject } from './drawPrompt';
import { askDraw, askRefusal, type IconTarget } from './iconTarget';

export const DRAW_WORDS = {
  button: 'Ask an agent to draw it',
  line: 'Asks an agent, in a new thread, to draw a new icon. What it sends back becomes the icon.',
} as const;

/** The facts the window has for the words: a project's name, folder, origin and newest threads; an agent's, with its project's. */
export function drawSubject(target: IconTarget, name: string): DrawSubject {
  if (target.kind === 'project') {
    const known = projectFacts(target.project);
    return { kind: 'project', name: target.name, folder: target.folder ?? known?.folder ?? null, repo: known?.repo ?? null, recent: known?.recent ?? [] };
  }
  const ref = typeof target.agent === 'string' ? { id: target.agent, session: target.agent, continues: [] as string[] } : target.agent;
  const sessions = [...new Set([ref.session ?? ref.id, ref.id, ...(ref.continues ?? [])])];
  const projectId = sessions.map((session) => sessionProjectOf(session)).find(Boolean)?.id ?? null;
  const project = projectId ? projectFacts(projectId) : null;
  return { kind: 'agent', name, project: project ? { name: project.name, folder: project.folder, repo: project.repo } : null, recent: sessionRecentTitles(sessions) };
}

/** A step on a poor link never spins for ever: past this it says so, and the button is back. */
const STEP_MS = 20_000;

/**
 * "Ask an agent to draw it", in the icon dialog's "Your own…" (AgentIconDialog.tsx), for an agent or a project. One
 * press keeps a request with the Inbox that has the icon (packages/server/inbox-icon-animate.ts), closes the dialog and
 * opens New message filled in (compose/openComposer.ts): the words (drawPrompt.ts), To open on the running agents and
 * "New <agent> session". The person sends it. The agent's hand-back becomes the icon in every window by itself.
 */
export function DrawIt({ target, name, onDone }: { target: IconTarget; name: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const subject = drawSubject(target, name);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      const request = await Promise.race([askDraw(target), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), STEP_MS))]);
      onDone();
      openComposer({ subject: DRAW_THREAD_NAME, body: drawPrompt(request, subject), to: 'pick' });
    } catch (cause) {
      setFailed(askRefusal(target, cause) ?? ANIMATE_WORDS.failed);
      setBusy(false);
    }
  };

  return (
    <div className="ib-agi-anim ib-agi-draw" data-draw-it="">
      <div className="ib-agi-anim-t">
        <span className="ib-agi-anim-l">{DRAW_WORDS.line}</span>
        {failed && (
          <span className="ib-agi-anim-e" role="status">
            {failed}
          </span>
        )}
      </div>
      <button type="button" className="ib-btn ib-sm ib-agi-anim-b" data-draw-go="" aria-busy={busy || undefined} disabled={busy} onClick={() => void start()}>
        {DRAW_WORDS.button}
      </button>
    </div>
  );
}
