import { Icon } from '../icons';
import { isTextCut, Tip } from './Tip';

/**
 * The held list's "N new" line: one line at every width (the owner, 2026-11-02: "1 new in appnotes · Users/ramos/…"
 * wrapped onto two). "N new in" and Show never shrink; the project's name takes the rest and is cut with "…", and
 * while it is cut the whole line is the tooltip.
 */
export function HeldNoticeLine({ count, project, onShow }: { count: number; project: string | null; onShow: () => void }) {
  const full = project ? `${count} new in ${project}` : `${count} new`;
  return (
    <Tip content={full} when={(button) => isTextCut(button.querySelector('.ib-notice-proj'))}>
      <button type="button" className="ib-notice" onClick={onShow} data-inbox-notice="">
        <Icon name="inbox" size={15} />
        <span className="ib-notice-text">
          <span className="ib-notice-n">{project ? `${count} new in` : `${count} new`}</span>
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
