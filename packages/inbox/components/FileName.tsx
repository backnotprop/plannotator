import { useEffect } from 'react';
import { sliceText } from '@plannotator/core/inbox-questions';

/**
 * A file name that is cut in the middle when it runs short, never at its
 * end: the end is what tells two files apart (the date, the version, the
 * extension), so "SPIKE-claude-code-mobile-annotations-20261012.md" reads
 * "SPIKE-claude-…-20261012.md" in a tile, not "SPIKE-claude-code-mob…".
 * The same two-part pattern code review's file rows use: the start shrinks
 * with an ellipsis, the end keeps its width. The full name is the hover
 * text, and the direction follows the name (`dir="auto"`), so an Arabic name
 * reads right to left and is cut at its own end.
 *
 * `wrap` draws the whole name, broken where it must, for places with room
 * (the download card). A cut name gets its whole name as hover text
 * (`data-clip`, clipTitle.ts) only while it is cut.
 */
export function FileName({ name, className, wrap = false }: { name: string; className?: string; wrap?: boolean }) {
  useEffect(keepNamesWholeOnCopy, []);
  const [head, tail] = splitFileName(name);
  const cls = `ib-fname${wrap ? ' ib-fname-wrap' : ''}${className ? ` ${className}` : ''}`;
  if (wrap || !tail) {
    return (
      <span className={cls} dir="auto" data-clip={wrap ? undefined : ''}>
        <span className="ib-fname-h">{name}</span>
      </span>
    );
  }
  // The two parts are flex items, which a screen reader would read apart
  // ("refund -policy.pdf"): they are hidden from it, and it hears the whole
  // name from `data-name` (inbox.css draws it as a visually hidden ::after).
  // The text content stays the name.
  return (
    <span className={cls} dir="auto" data-clip="" data-name={name}>
      <span className="ib-fname-h" aria-hidden="true">
        {head}
      </span>
      <span className="ib-fname-t" aria-hidden="true">
        {tail}
      </span>
    </span>
  );
}

let copyListeners = 0;

/**
 * The two parts of a cut name are flex items, so a selection's text puts a
 * line break between them: a copy that takes in a cut name gets the name
 * whole instead. Installed once while any FileName is on the page.
 */
function keepNamesWholeOnCopy(): () => void {
  if (copyListeners++ === 0) document.addEventListener('copy', onCopy);
  return () => {
    if (--copyListeners === 0) document.removeEventListener('copy', onCopy);
  };
}

function onCopy(event: ClipboardEvent): void {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !event.clipboardData) return;
  const text = selection.toString();
  let whole = text;
  for (const el of document.querySelectorAll<HTMLElement>('.ib-fname[data-name]')) {
    if (!selection.containsNode(el, true)) continue;
    const head = el.querySelector('.ib-fname-h')?.textContent ?? '';
    const tail = el.querySelector('.ib-fname-t')?.textContent ?? '';
    if (!head || !tail) continue;
    // A selection across the cut holds the head's last character, the break, then the tail's first, however
    // much of either part it took.
    whole = whole.split(`${head.slice(-1)}\n${tail.slice(0, 1)}`).join(`${head.slice(-1)}${tail.slice(0, 1)}`);
  }
  if (whole === text) return;
  event.clipboardData.setData('text/plain', whole);
  event.preventDefault();
}

/** Names this short are never cut in the middle: there is nothing to keep apart. */
const SHORT = 16;
/** The most of the stem kept with the extension. */
const TAIL_STEM = 12;

/**
 * The name split where a middle cut goes: `[start, end]`, the end being the
 * extension and the last part of the stem (after its last `-`, `_`, `.` or
 * space when that part is short, else its last few characters), never
 * splitting a character. `end` is empty for a short name.
 */
export function splitFileName(name: string): [string, string] {
  if (name.length <= SHORT) return [name, ''];
  const dot = name.lastIndexOf('.');
  // An extension: a dot that is not the first character, 1 to 8 letters or digits after it.
  const ext = dot > 0 && /^\.[\p{L}\p{N}]{1,8}$/u.test(name.slice(dot)) ? name.slice(dot) : '';
  const stem = ext ? name.slice(0, -ext.length) : name;
  const sep = Math.max(stem.lastIndexOf('-'), stem.lastIndexOf('_'), stem.lastIndexOf(' '), stem.lastIndexOf('.'));
  let keep: string;
  if (sep > 0 && stem.length - sep <= TAIL_STEM + 1) keep = stem.slice(sep);
  else {
    // The last few characters, never half of one: cut the stem's start whole, keep what is left.
    const start = sliceText(stem, Math.max(0, stem.length - 6));
    keep = stem.slice(start.length);
  }
  const tail = `${keep}${ext}`;
  const head = name.slice(0, name.length - tail.length);
  return head ? [head, tail] : [name, ''];
}
