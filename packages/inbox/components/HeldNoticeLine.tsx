import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { isTextCut, Tip } from './Tip';

/**
 * The held list's "N new" line: one line at every width (the owner, 2026-11-02: "1 new in appnotes · Users/ramos/…"
 * wrapped onto two). "N new in" and Show never shrink; the project's name takes the rest and is cut with "…", and
 * while it is cut the whole line is the tooltip.
 *
 * It sticks to the top of the list's scroll box (the owner, 2026-11-17: "always in reach, never scrolling out of
 * sight"; inbox.css `.ib-notice-stick`). At rest it is where it always was, above the rows; the box around it is the
 * list's own ground, so rows scroll under it unseen. Its look is unchanged.
 */
export function HeldNoticeLine({ count, project, onShow }: { count: number; project: string | null; onShow: () => void }) {
  const full = project ? `${count} new in ${project}` : `${count} new`;
  return (
    <div className="ib-notice-stick" data-held-bar="">
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
    </div>
  );
}

/**
 * What a screen reader hears of the bar: its words once each time the count changes, politely. Drawn whether or not
 * the bar is, so a count that appears is said; never on a scroll (the bar sticking says nothing). Show empties it,
 * which says nothing, so the next count is said afresh. Another list (`place`: a project, a folder) says nothing:
 * its count is not news that arrived, it is what that list already holds.
 */
export function HeldNoticeSaid({ count, project, place }: { count: number; project: string | null; place: string }) {
  const words = count > 0 ? (project ? `${count} new in ${project}` : `${count} new`) : '';
  const [said, setSaid] = useState('');
  const last = useRef({ words, place });
  useEffect(() => {
    const was = last.current;
    if (words === was.words && place === was.place) return;
    last.current = { words, place };
    setSaid(place === was.place ? words : '');
  }, [words, place]);
  return (
    <span className="ib-sr" aria-live="polite" data-held-said="">
      {said}
    </span>
  );
}
