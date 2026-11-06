import type { CSSProperties } from 'react';
import { Modal } from './Updates';

/** The dialog's words (a proposal for the owner, in the PR's "Words for the owner"). */
export const LIST_VIEW_INTRO_WORDS = {
  title: 'List',
  line: 'Every thread in one list, newest first.',
  note: 'Switch back any time in the ⋮ menu.',
  keep: 'Keep Grouped',
  use: 'Use List',
} as const;

/**
 * The picture's rows: where each sits in the groups (`g`) and in one list (`l`), px from the top, and its two bars'
 * widths. Bands sit between them in the groups and fade out as the rows take their places in the list.
 */
const ROWS: { g: number; l: number; w: [number, number]; dot: 'stop' | 'ask' | 'new' | 'read' }[] = [
  { g: 16, l: 42, w: [70, 46], dot: 'stop' },
  { g: 34, l: 96, w: [58, 40], dot: 'ask' },
  { g: 68, l: 24, w: [76, 52], dot: 'new' },
  { g: 86, l: 60, w: [62, 44], dot: 'new' },
  { g: 120, l: 78, w: [66, 38], dot: 'read' },
];
const BANDS = [0, 52, 104];

/** The picture: a small grouped list whose bands fade while its rows slide into one list, newest first. Decoration only. */
function ListViewIntroArt() {
  return (
    <div className="ib-lvi-art" aria-hidden="true">
      {BANDS.map((top) => (
        <span key={top} className="ib-lvi-band" style={{ top }} />
      ))}
      {ROWS.map((row, i) => (
        <span key={i} className="ib-lvi-row" data-dot={row.dot} style={{ '--g': `${row.g}px`, '--l': `${row.l}px` } as CSSProperties}>
          <i />
          <b style={{ width: `${row.w[0]}%` }} />
          <b style={{ width: `${row.w[1]}%` }} />
        </span>
      ))}
    </div>
  );
}

/**
 * The List view's one-time announcement (approval "inbox-list-view", the owner's ask, 2026-11-05: "a dialogue … if you
 * don't want dynamic grouping threads … a simple email list style … a cool dialogue just like the … bro mode one").
 * Bro mode's card (PR #2693, `BroIntro`): the name as the picture, over the reveals' frame (`.ib-bi`, the Inbox's Modal),
 * here in the window's own colours so it follows light and dark, with a small list that folds its groups into one
 * (at rest in the list under reduced motion). "Use List" switches at once and is remembered as the ⋮ menu's choice;
 * "Keep Grouped", Escape and a click outside leave the groups. Every way out is final: it opens once per browser. No
 * keyboard shortcut.
 */
export function ListViewIntro({ phone, onKeep, onUseList }: { phone: boolean; onKeep: () => void; onUseList: () => void }) {
  const words = LIST_VIEW_INTRO_WORDS;
  return (
    <Modal labelledBy="ib-lvi-title" describedBy="ib-lvi-desc" testId="list-view-intro" onClose={onKeep} ownKeys className={`ib-bi ib-lvi${phone ? ' ib-bi-phone' : ''}`}>
      <div className="ib-lvi-poster">
        <h2 id="ib-lvi-title">
          {words.title}
          <span className="ib-sr"> view</span>
        </h2>
        <ListViewIntroArt />
      </div>
      <div className="ib-bi-text">
        <p id="ib-lvi-desc">{words.line}</p>
        <p className="ib-bi-q">{words.note}</p>
      </div>
      <div className="ib-bi-acts">
        <button type="button" className="ib-btn ib-ghost" onClick={onKeep} data-list-view-intro-keep="">
          {words.keep}
        </button>
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-pri ib-bi-copy" onClick={onUseList} data-list-view-intro-use="">
          {words.use}
        </button>
      </div>
    </Modal>
  );
}
