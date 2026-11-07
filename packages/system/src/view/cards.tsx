// The Key (symbols and keys) and the notes of the sheet on screen, as small
// cards over the stage, opened from the zoom group (Key) and with N.
import { Fragment } from 'react';
import { MOVES, MOVES_ORDER } from '../draw/grammar.ts';
import type { SheetLayout } from '../layout/types.ts';

const Kbd = ({ k }: { k: string }) => <kbd className="sys-kbd">{k}</kbd>;

const Swatch = ({ is, dashed }: { is?: 'added' | 'changed' | 'removed'; dashed?: boolean }) => (
  <svg width="26" height="16" viewBox="0 0 26 16" aria-hidden="true">
    <rect x="1" y="1" width="24" height="14" rx="2" fill={is === 'changed' ? 'color-mix(in oklab, var(--sys-chg-ink) 11%, var(--sys-box))' : 'var(--sys-box)'}
      stroke={is ? `var(--sys-${is === 'added' ? 'add' : is === 'changed' ? 'chg' : 'gone'}-ink)` : 'var(--sys-line)'} strokeWidth="1.3" strokeDasharray={dashed || is === 'removed' ? '3 2' : undefined} />
  </svg>
);

/** What the change on the sheet means: a PR's review, a plan, or only the parts its files touch (the gate). */
export type KeyChange = 'review' | 'plan' | 'gate' | null;

export function KeyCard({ notes, sheets, keys, pane, change = null }: { notes: boolean; sheets: boolean; keys: boolean; pane: boolean; change?: KeyChange }) {
  return (
    <div className="sys-card-pop sys-keycard" role="dialog" aria-label="Symbols and keys">
      {change && (
        <>
          <div className="sys-kc-h">{change === 'plan' ? 'This plan' : 'This change'}</div>
          {change !== 'gate' && <div className="sys-kc-r"><span className="sys-kc-i"><Swatch is="added" dashed={change === 'plan'} /></span><span>{change === 'plan' ? 'new, not built yet' : 'added'}</span></div>}
          <div className="sys-kc-r"><span className="sys-kc-i"><Swatch is="changed" dashed={change === 'plan'} /></span><span>{change === 'plan' ? 'changes, not built yet' : change === 'gate' ? 'its files change' : 'changed'}</span></div>
          {change === 'review' && <div className="sys-kc-r"><span className="sys-kc-i"><Swatch is="removed" /></span><span>removed, struck through</span></div>}
          {change === 'review' && <div className="sys-kc-r"><span className="sys-kc-i"><span className="sys-kc-num">1</span></span><span>its number in the parts list</span></div>}
        </>
      )}
      <div className="sys-kc-h">Symbols</div>
      <div className="sys-kc-r">
        <span className="sys-kc-i"><svg width="40" height="10" aria-hidden="true"><path d="M2 5H31" stroke="var(--sys-line)" strokeWidth="1.3" /><path d="M38 5l-9 3.6v-7.2z" fill="var(--sys-line)" /></svg></span>
        <span>a line: what moves, and which way</span>
      </div>
      <div className="sys-kc-r"><span className="sys-kc-i"><span className="sys-letter">a</span></span><span>a note: hover or focus its letter</span></div>
      <div className="sys-kc-r">
        <span className="sys-kc-i"><svg width="26" height="18" viewBox="0 0 26 18" aria-hidden="true"><rect x="1.5" y="0.5" width="20" height="13" rx="1.5" fill="var(--sys-box)" stroke="var(--sys-line)" /><path d="M4.5 16.5h19v-13" fill="none" stroke="var(--sys-line-faint)" /></svg></span>
        <span>a part with sheets inside: zoom in, or open it</span>
      </div>
      <div className="sys-kc-h">Lines</div>
      {MOVES_ORDER.map((m) => (
        <div className="sys-kc-r" key={m}>
          <span className="sys-kc-i"><svg width="40" height="10" aria-hidden="true"><path d="M2 5H38" stroke={MOVES[m].ink} strokeWidth="2.2" /></svg></span>
          <span><b className="sys-kc-w">{MOVES[m].word}</b> {MOVES[m].key}</span>
        </div>
      ))}
      <div className="sys-kc-h">Keys, with the drawing in focus</div>
      <div className="sys-kc-k"><Kbd k="Tab" /><Kbd k="←↑→↓" /><span>move between parts</span></div>
      <div className="sys-kc-k"><Kbd k="Enter" /><span>open a part with sheets inside</span></div>
      <div className="sys-kc-k"><Kbd k="Esc" /><span>up one level</span></div>
      {keys && (
        <>
          <div className="sys-kc-k"><Kbd k="+" /><Kbd k="−" /><Kbd k="F" /><span>zoom in, out, fit</span></div>
          {sheets && <div className="sys-kc-k"><Kbd k="1" />to<Kbd k="9" /><span>the sheets here</span></div>}
          {notes && <div className="sys-kc-k"><Kbd k="N" /><span>every note of this sheet</span></div>}
        </>
      )}
      <div className="sys-kc-k"><span>{pane ? 'Drag to move; a pinch, or the wheel with Ctrl or ⌘, zooms' : 'Drag to move; the wheel or a pinch zooms'}</span></div>
    </div>
  );
}

export function NotesCard({ notes, onClose }: { notes: SheetLayout['notes']; onClose: () => void }) {
  return (
    <div className="sys-card-pop sys-notescard" role="dialog" aria-label="Notes on this sheet">
      <div className="sys-kc-h">
        <span>Notes</span>
        <button type="button" className="sys-card-x" aria-label="Close the notes" title="Close" onClick={onClose}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>
      {notes.map((n) => (
        <Fragment key={n.l}>
          <div className="sys-note-row"><span className="sys-letter">{n.l}</span><span>{n.text}</span></div>
        </Fragment>
      ))}
    </div>
  );
}
