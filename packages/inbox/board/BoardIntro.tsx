import { useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { HostMark, Icon } from '../icons';
import { Modal } from '../components/Updates';
import { boardPrompt } from './boardPrompt';

export const BOARD_PROMPT_COPIED_MS = 2000;

export function useCopyBoardPrompt(mcpCommand: readonly string[] | null | undefined) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [copiedOnce, setCopiedOnce] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    const ok = await copyTextToClipboard(boardPrompt(mcpCommand));
    setState(ok ? 'copied' : 'failed');
    if (ok) setCopiedOnce(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), BOARD_PROMPT_COPIED_MS);
  };
  return { state, copiedOnce, copy };
}

export function BoardIntro({ mcpCommand, phone, onClose, onTurnOn }: { mcpCommand: readonly string[] | null | undefined; phone: boolean; onClose: () => void; onTurnOn?: () => void }) {
  const { state, copiedOnce, copy } = useCopyBoardPrompt(mcpCommand);
  if (onTurnOn) {
    return (
      <Modal labelledBy="ib-bi-title" describedBy="ib-bi-desc" testId="board-intro" onClose={onClose} ownKeys className={`ib-bi${phone ? ' ib-bi-phone' : ''}`}>
        <BoardIntroArt />
        <BoardIntroText prompt={false} />
        <div className="ib-bi-acts">
          <button type="button" className="ib-btn ib-ghost" onClick={onClose} data-board-intro-close="">
            Not now
          </button>
          <span className="ib-bsp" />
          <button type="button" className="ib-btn ib-pri ib-bi-copy" onClick={onTurnOn} data-board-intro-on="">
            Turn it on
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal labelledBy="ib-bi-title" describedBy="ib-bi-desc" testId="board-intro" onClose={onClose} ownKeys className={`ib-bi${phone ? ' ib-bi-phone' : ''}`}>
      <BoardIntroArt />
      <BoardIntroText prompt />
      <div className="ib-bi-acts">
        <button type="button" className="ib-btn ib-ghost" onClick={onClose} data-board-intro-close="">
          {copiedOnce ? 'Done' : 'Not now'}
        </button>
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-pri ib-bi-copy" onClick={() => void copy()} data-board-intro-copy="" data-copied={state === 'copied' ? '' : undefined}>
          <Icon name={state === 'copied' ? 'check' : 'copy'} size={15} />
          {state === 'copied' ? 'Copied' : 'Copy prompt'}
        </button>
      </div>
      <div className="ib-sr" aria-live="polite" data-board-intro-live="">
        {state === 'copied' ? 'Board prompt copied.' : state === 'failed' ? 'The prompt could not be copied.' : ''}
      </div>
    </Modal>
  );
}

function BoardIntroText({ prompt }: { prompt: boolean }) {
  return (
    <div className="ib-bi-text">
      <h2 id="ib-bi-title">Your Board</h2>
      <p id="ib-bi-desc">Work in flight, by stage. Agents keep their cards current.</p>
      {prompt && <p className="ib-bi-q">The prompt asks an agent to add the work it knows about.</p>}
    </div>
  );
}

const LANES: { col: string; cards: { host: string | null; you?: boolean; w: [number, number] }[] }[] = [
  { col: 'backlog', cards: [{ host: null, w: [72, 52] }] },
  { col: 'todo', cards: [{ host: 'codex', w: [64, 44] }] },
  { col: 'in_progress', cards: [{ host: 'opencode', w: [60, 48] }] },
  { col: 'in_review', cards: [{ host: 'pi', you: true, w: [78, 58] }, { host: 'codex', you: true, w: [66, 50] }] },
  { col: 'done', cards: [{ host: 'claude-code', w: [70, 40] }] },
];
const NAMES: Record<string, string> = { backlog: 'Backlog', todo: 'Todo', in_progress: 'In progress', in_review: 'In review', done: 'Done' };

function BoardIntroArt() {
  const card = (c: { host: string | null; you?: boolean; w: [number, number] }, extra = '') => (
    <div className={`ib-bi-c${c.you ? ' ib-bi-you' : ''}${extra}`}>
      {c.host ? <HostMark host={c.host} /> : <span className="ib-lane-dot ib-bi-none" data-col="backlog" />}
      <span className="ib-bi-bars">
        <b style={{ width: `${c.w[0]}%` }} />
        <b style={{ width: `${c.w[1]}%` }}>{extra && <span className="ib-bi-amb" />}</b>
      </span>
    </div>
  );
  return (
    <div className="ib-bi-art" aria-hidden="true">
      <div className="ib-bi-stage">
        {LANES.map((lane) => (
          <div className="ib-bi-lane" key={lane.col}>
            <div className="ib-bi-lh">
              <span className="ib-lane-dot" data-col={lane.col} />
              <span>{NAMES[lane.col]}</span>
            </div>
            {lane.cards.map((c, i) => (
              <div key={i}>{card(c)}</div>
            ))}
          </div>
        ))}
        {card({ host: 'claude-code', w: [74, 56] }, ' ib-bi-walk')}
      </div>
    </div>
  );
}
