import { heldNoticeHead } from '../held';
import { Icon } from '../icons';
import { isTextCut, Tip } from './Tip';

/**
 * The held list's "N new" line: one line at every width (the owner, 2026-11-02: "1 new in appnotes · Users/ramos/…"
 * wrapped onto two). "N new in" and Show never shrink; the project's name takes the rest and is cut with "…", and
 * while it is cut the whole line is the tooltip.
 */
export function HeldNoticeLine({ count, questions, project, onShow }: { count: number; questions?: number; project: string | null; onShow: () => void }) {
  // "2 new · 5 questions" when the threads asked more questions than there are threads (held.ts `heldNotice`).
  const head = heldNoticeHead(count, questions);
  const full = project ? `${head} in ${project}` : head;
  return (
    <Tip content={full} when={(button) => isTextCut(button.querySelector('.ib-notice-proj'))}>
      <button type="button" className="ib-notice" onClick={onShow} data-inbox-notice="">
        <Icon name="inbox" size={15} />
        <span className="ib-notice-text">
          <span className="ib-notice-n">{project ? `${head} in` : head}</span>
          {/* A space for the line's text and accessible name; the flex gap draws it. */}
          {project && ' '}
          {project && (
            <bdi className="ib-notice-proj" data-notice-project={project}>
              {project}
            </bdi>
          )}
        </span>
        <b>Show</b>
      </button>
    </Tip>
  );
}
