import { useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { HostMark, Icon } from '../icons';
import { Modal } from '../components/Updates';
import { boardPrompt } from './boardPrompt';

/** How long "Copied" shows on Copy prompt. */
export const BOARD_PROMPT_COPIED_MS = 2000;

/**
 * Copy the Board prompt: `state` says "Copied" for 2 s (or that it failed);
 * the caller's live region says it once.
 */
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

/**
 * The Board's first-visit dialog (approval "inbox-board", intro amendment, as
 * mocked): a small animated board (a card walks through the stages; under
 * reduced motion it rests in Your look), "Your Board", one line, the quiet
 * line about the prompt, Copy prompt (check and "Copied" for 2 s; "Not now"
 * becomes "Done") and Not now. The Inbox's Modal shell, as the sound dialog.
 * Shown once per machine; the header's "?" opens it again.
 */
export function BoardIntro({ mcpCommand, phone, onClose }: { mcpCommand: readonly string[] | null | undefined; phone: boolean; onClose: () => void }) {
  const { state, copiedOnce, copy } = useCopyBoardPrompt(mcpCommand);
  return (
    <Modal labelledBy="ib-bi-title" describedBy="ib-bi-desc" testId="board-intro" onClose={onClose} ownKeys className={`ib-bi${phone ? ' ib-bi-phone' : ''}`}>
      <BoardIntroArt />
      <div className="ib-bi-text">
        <h2 id="ib-bi-title">Your Board</h2>
        <p id="ib-bi-desc">Work in flight, by stage. Agents keep their cards current.</p>
        <p className="ib-bi-q">The prompt asks an agent to add the work it knows about.</p>
      </div>
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

const LANES: { col: string; cards: { host: string | null; you?: boolean; w: [number, number] }[] }[] = [
  { col: 'backlog', cards: [{ host: null, w: [72, 52] }] },
  { col: 'designing', cards: [{ host: 'codex', w: [64, 44] }] },
  { col: 'your_look', cards: [{ host: 'pi', you: true, w: [78, 58] }] },
  { col: 'building', cards: [{ host: 'opencode', w: [60, 48] }, { host: 'claude-code', w: [70, 40] }] },
  { col: 'your_review', cards: [{ host: 'codex', you: true, w: [66, 50] }] },
];
const NAMES: Record<string, string> = { backlog: 'Backlog', designing: 'Designing', your_look: 'Your look', building: 'Building', your_review: 'Your review' };

/** The picture: a small board, one card walking through its stages. Decoration only (aria-hidden). */
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
