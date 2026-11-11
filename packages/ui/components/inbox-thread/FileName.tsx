import { useEffect } from 'react';
import { sliceText } from '@plannotator/core/inbox-questions';
import { Tip } from './Tip';

/**
 * The full name is the hover text, and the direction follows the name (`dir="auto"`), so an
 * Arabic name reads right to left and is cut at its own end.
 */
export function FileName({ name, className, wrap = false }: { name: string; className?: string; wrap?: boolean }) {
  useEffect(keepNamesWholeOnCopy, []);
  const [head, tail] = splitFileName(name);
  const cls = `ib-fname${wrap ? ' ib-fname-wrap' : ''}${className ? ` ${className}` : ''}`;
  if (wrap) {
    return (
      <span className={cls} dir="auto">
        <span className="ib-fname-h">{name}</span>
      </span>
    );
  }
  if (!tail) {
    return (
      <Tip content={name} cut>
        <span className={cls} dir="auto">
          <span className="ib-fname-h">{name}</span>
        </span>
      </Tip>
    );
  }
  // The two parts are flex items, which a screen reader would read apart ("refund -policy.pdf"):
  // they are hidden from it, and it hears the whole name from `data-name` (inbox.css draws it as a
  // visually hidden ::after).
  return (
    <Tip content={name} cut>
      <span className={cls} dir="auto" data-name={name}>
        <span className="ib-fname-h" aria-hidden="true">
          {head}
        </span>
        <span className="ib-fname-t" aria-hidden="true">
          {tail}
        </span>
      </span>
    </Tip>
  );
}

let copyListeners = 0;

/**
 * The two parts of a cut name are flex items, so a selection's text puts a line break between
 * them: a copy that takes in a cut name gets the name whole instead.
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
    whole = whole.split(`${head.slice(-1)}\n${tail.slice(0, 1)}`).join(`${head.slice(-1)}${tail.slice(0, 1)}`);
  }
  if (whole === text) return;
  event.clipboardData.setData('text/plain', whole);
  event.preventDefault();
}

/** Names this short are never cut in the middle: there is nothing to keep apart. */
const SHORT = 16;
const TAIL_STEM = 12;

/**
 * The name split where a middle cut goes: `[start, end]`, the end being the extension and the
 * last part of the stem (after its last `-`, `_`.
 */
export function splitFileName(name: string): [string, string] {
  if (name.length <= SHORT) return [name, ''];
  const dot = name.lastIndexOf('.');
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
