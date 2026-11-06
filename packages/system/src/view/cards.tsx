// The Key (symbols and keys) and the notes of the sheet on screen, as small
// cards over the stage, opened from the zoom group (Key) and with N.
import { Fragment } from 'react';
import { MOVES, MOVES_ORDER } from '../draw/grammar.ts';
import type { SheetLayout } from '../layout/types.ts';

const Kbd = ({ k }: { k: string }) => <kbd className="sys-kbd">{k}</kbd>;

export function KeyCard({ notes, sheets, keys }: { notes: boolean; sheets: boolean; keys: boolean }) {
  return (
    <div className="sys-card-pop sys-keycard" role="dialog" aria-label="Symbols and keys">
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
          <span>{MOVES[m].word}: {MOVES[m].key}</span>
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
      <div className="sys-kc-k"><span>Drag to move; the wheel or a pinch zooms</span></div>
    </div>
  );
}

export function NotesCard({ notes }: { notes: SheetLayout['notes'] }) {
  return (
    <div className="sys-card-pop sys-notescard" role="dialog" aria-label="Notes on this sheet">
      {notes.map((n) => (
        <Fragment key={n.l}>
          <div className="sys-note-row"><span className="sys-letter">{n.l}</span><span>{n.text}</span></div>
        </Fragment>
      ))}
    </div>
  );
}
