import { Component, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Icon } from '../icons';
import { holdView, restoreView, type ViewHold } from '../holdView';
import type { InboxListGroupId } from '@plannotator/core/inbox-types';
import { countLine, type NewsLine } from '../newsWords';
import { isTextCut, Tip } from './Tip';

/** What the list hands the bar (app/useListView.ts): the held count and its one project, and what came here and elsewhere. */
export interface ListNotice {
  count: number;
  project?: string | null;
  lands?: readonly InboxListGroupId[];
  /** What came in this list (newsWords.ts `hereLine`); absent: "N new in <project>", the words before it said what came. */
  here?: NewsLine | null;
  /** What came outside this project or filter view (`elsewhereLine`): drawn only where the list can go to the Inbox. */
  elsewhere?: NewsLine | null;
}

/** The bar's lines: here while threads are held (`held`), elsewhere when the list can leave its view; the words said. */
export function noticeLines(notice: ListNotice | null, held: boolean, canLeave: boolean) {
  const here = held && notice ? (notice.here ?? countLine(notice.count, notice.project ?? null)) : null;
  const elsewhere = canLeave ? (notice?.elsewhere ?? null) : null;
  return { here, elsewhere, lines: (here ? 1 : 0) + (elsewhere ? 1 : 0), words: [here?.full, elsewhere?.full].filter(Boolean).join('. ') };
}

/**
 * One of the held list's lines (newsWords.ts): what came, then Show (or Show all). One line at every width (the owner,
 * 2026-11-02: "1 new in appnotes · " and a long folder path wrapped onto two). The lead ("Claude Code replied in", "2 replies")
 * and the action never shrink; the thread's or project's name takes the rest and is cut with "…"; "from …" is left
 * off whole when there is no room for it (inbox.css: it wraps onto a second line the box clips). While anything is
 * cut, the whole sentence is the tooltip. The button's accessible name is its words, uncut (a clipped part is still read).
 */
function NewsButton({ line, onPress, elsewhere }: { line: NewsLine; onPress: () => void; elsewhere: boolean }) {
  return (
    <Tip content={line.full} when={(button) => lineCut(button)}>
      <button
        type="button"
        className="ib-notice"
        onClick={onPress}
        {...(elsewhere ? { 'data-inbox-notice-elsewhere': '' } : { 'data-inbox-notice': '' })}
      >
        <Icon name="inbox" size={15} />
        <span className="ib-notice-text" data-drop={line.from ? '' : undefined}>
          <span className="ib-notice-n">{line.lead}</span>
          {/* Spaces for the line's text; the flex gap draws them. */}
          {line.name && ' '}
          {line.name && (
            <bdi className="ib-notice-proj" data-notice-project={line.name}>
              {line.name}
            </bdi>
          )}
          {line.from && ' '}
          {line.from && <span className="ib-notice-from">{line.from}</span>}
        </span>
        <b>{line.action}</b>
      </button>
    </Tip>
  );
}

/** Some of the line's words are not on screen: the name is cut, or "from …" was left off (it wrapped). */
function lineCut(button: Element): boolean {
  if (isTextCut(button.querySelector('.ib-notice-proj')) || isTextCut(button.querySelector('.ib-notice-n'))) return true;
  const from = button.querySelector<HTMLElement>('.ib-notice-from');
  const lead = button.querySelector<HTMLElement>('.ib-notice-n');
  return !!from && !!lead && from.offsetTop > lead.offsetTop;
}

/**
 * The bar: the line for news in this list (Show), and in a project or filter view the line for news elsewhere
 * (Show all), here first. It sticks to the top of the list's scroll box (the owner, 2026-11-17: "always in reach,
 * never scrolling out of sight"; inbox.css `.ib-notice-stick`). At rest it is where it always was, above the rows;
 * the box around it is the list's own ground, so rows scroll under it unseen. Its look is unchanged.
 */
export function HeldNoticeLine({ here, elsewhere, onShow, onShowAll }: { here: NewsLine | null; elsewhere: NewsLine | null; onShow: () => void; onShowAll?: () => void }) {
  const lines = (here ? 1 : 0) + (elsewhere && onShowAll ? 1 : 0);
  if (lines === 0) return null;
  return (
    <div className="ib-notice-stick" data-held-bar="" data-lines={lines}>
      {here && <NewsButton line={here} onPress={onShow} elsewhere={false} />}
      {elsewhere && onShowAll && <NewsButton line={elsewhere} onPress={onShowAll} elsewhere />}
    </div>
  );
}

/**
 * The bar's arrival never moves what the person is reading (the owner, 2026-11-18: a sticky bar must not make the
 * list jump under the finger). The bar is drawn in the flow at the list's top, so it coming (or a second line coming,
 * or it going without Show) moves every row by its height. Chromium's scroll anchoring makes up for that on a
 * desktop; Safari has none and a phone's list turns it off. So while the list is scrolled down, the rows on screen
 * are noted before the commit (`getSnapshotBeforeUpdate`, before any DOM change) and put back after it (holdView.ts,
 * the rule Show uses), by however far they moved: 0 where the browser already kept them. At the list's very top the
 * bar takes its place above the rows, as it always has: held there, it would cover the first row.
 */
export class HoldViewOnBar extends Component<{ body: RefObject<HTMLElement | null>; lines: number; children?: ReactNode }> {
  getSnapshotBeforeUpdate(prev: { lines: number }): ViewHold | null {
    const body = this.props.body.current;
    if (prev.lines === this.props.lines || !body || body.scrollTop <= 0) return null;
    return holdView(body);
  }

  componentDidUpdate(_prev: unknown, _state: unknown, hold: ViewHold | null) {
    const body = this.props.body.current;
    if (hold && body) restoreView(body, hold);
  }

  render() {
    return this.props.children ?? null;
  }
}

/**
 * What a screen reader hears of the bar: its words once each time they change, politely. Drawn whether or not the
 * bar is, so words that appear are said; never on a scroll (the bar sticking says nothing). Show empties it, which
 * says nothing, so the next words are said afresh. Another list (`place`: a project, a folder) says nothing: its
 * line is not news that arrived, it is what that list already holds.
 */
export function HeldNoticeSaid({ words, place }: { words: string; place: string }) {
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
