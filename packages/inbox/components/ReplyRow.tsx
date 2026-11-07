/**
 * The reply box's own row (approval "inbox-reply-box", T6, 2026-11-07): Send and the tools in the box, under the
 * words, the way a mail app draws them. The row never wraps and its controls never move.
 *
 * - A computer: Send, the paperclip, Skills and the mic at the left; one middle cell for what goes with the reply
 *   (the chips, or the one summary line when they don't fit) and who gets it; the bin at the far right.
 * - A phone (the owner: "maybe we don't need delete icon. I like attachment on left"): the paperclip and Skills at
 *   the left, the mic and Send at the right edge. No bin: the Draft line above the box keeps Discard. What goes with
 *   the reply and who gets it sit on their own line over the row (Thread.tsx).
 * - Voice (decision D5): while a take runs, its status takes the middle cell's place (a computer: the chips and the
 *   picker; a phone: the paperclip and Skills), in the same box, so nothing reflows and nothing still in use is
 *   covered. The mic and Send stay where they are.
 * - Chips or summary (decision D4): the chips when they fit beside the picker, else the summary line. Measured
 *   before paint, again whenever the cell's width, the chips' words, the text size or the fonts change; held while
 *   the person is in the cell (a chip, the line, or a list or sheet open from them), so it never remounts under them.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useInboxTextSize } from '../textSize';

export function ReplyRow({
  phone,
  keepOpen,
  send,
  clip,
  skills,
  mic,
  status,
  files,
  chips,
  summary,
  pill,
  discard,
  hint = null,
  fold,
  onFold,
  fitKey,
}: {
  phone: boolean;
  /** The open questions stay open with this Send (the skip chip's quieter look). */
  keepOpen: boolean;
  send: ReactNode;
  clip: ReactNode;
  skills: ReactNode;
  mic: ReactNode;
  /** The voice status, nothing while idle (`VoiceStatusLine`). */
  status: ReactNode;
  /** "27 files" past a handful (decision D2), else nothing. */
  files: ReactNode;
  /** A computer: what goes with the reply, as chips. */
  chips: ReactNode;
  /** A computer: the same as one line, drawn instead of the chips when they don't fit (`fold`). */
  summary: ReactNode;
  /** A computer: who gets the reply, when the thread has several agents. */
  pill: ReactNode;
  /** A computer: the bin. */
  discard: ReactNode;
  /**
   * A short quiet line for a moment ("No skills are installed"), in the middle cell: over the chips on a computer (they
   * step aside, as for voice), after the paperclip and Skills on a phone.
   */
  hint?: ReactNode;
  fold: boolean;
  onFold: (fold: boolean) => void;
  /** Changes whenever the chips' words do. */
  fitKey: string;
}) {
  const midRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const textSize = useInboxTextSize();
  const [width, setWidth] = useState(0);
  const [fonts, setFonts] = useState(0);
  const key = `${fitKey}|${textSize}|${width}|${fonts}|${pill ? 1 : 0}|${files ? 1 : 0}`;
  const measured = useRef(key);
  /** The fold the last fit was checked at (null: not yet, or since a change). */
  const checked = useRef<boolean | null>(null);
  // Bumped when focus leaves the cell, so a fit held while the person was in it is tried again.
  const [, setLeft] = useState(0);
  // Tried unfolded first whenever something changed, then folded only if the chips overflow the cell (before paint).
  // Not while the person is in the cell (focus on a chip or the summary line, or a sheet or the comments list open from
  // it): trying again would remount what they are in and drop it (a "Skip them" press would close its own sheet; the
  // last comment removed from the chip's list would send focus to the line, not the field), and an open list would be
  // measured as chips. The fit waits for a later render once they have left (focus leaving the cell brings one).
  useLayoutEffect(() => {
    if (phone) return;
    const layer = layerRef.current;
    if (!layer) return;
    const changed = measured.current !== key;
    if (!changed && checked.current === fold) return;
    if (inCell(layer)) return;
    if (changed && fold) {
      measured.current = key;
      checked.current = null;
      onFold(false);
      return;
    }
    measured.current = key;
    checked.current = fold;
    if (!fold && layer.scrollWidth > layer.clientWidth + 1) onFold(true);
  });
  useEffect(() => {
    const mid = midRef.current;
    if (phone || !mid || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(Math.round(mid.clientWidth)));
    observer.observe(mid);
    return () => observer.disconnect();
  }, [phone]);
  useEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => live && setFonts((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);

  if (phone) {
    return (
      <div className={`ib-rrow${keepOpen ? ' ib-keep' : ''}`} data-reply-row="" data-phone="">
        <div className="ib-rmid">
          <div className="ib-rlayer">
            {clip}
            {skills}
            {files}
            {hint && (
              <span className="ib-rhint" data-reply-hint="">
                {hint}
              </span>
            )}
          </div>
          {status}
        </div>
        {mic}
        {send}
      </div>
    );
  }
  return (
    <div className={`ib-rrow${keepOpen ? ' ib-keep' : ''}`} data-reply-row="">
      <div className="ib-rlead">
        {send}
        {clip}
        {skills}
        {mic}
      </div>
      <div className="ib-rmid" ref={midRef} data-fold={fold ? '' : undefined} data-hint={hint ? '' : undefined}>
        <div
          className="ib-rlayer"
          ref={layerRef}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setLeft((n) => n + 1);
          }}
        >
          {files}
          {fold ? summary : <span className="ib-rchips">{chips}</span>}
          {pill && <span className="ib-rto-cell">{pill}</span>}
        </div>
        {hint && (
          <span className="ib-rhint" data-reply-hint="">
            {hint}
          </span>
        )}
        {status}
      </div>
      {discard}
    </div>
  );
}

/** The person is in the middle cell: focus on a chip or the summary line, or a sheet or the comments list open from it. */
function inCell(layer: HTMLElement): boolean {
  const active = document.activeElement;
  return (active !== null && active !== layer && layer.contains(active)) || layer.querySelector('[aria-expanded="true"]') !== null;
}
