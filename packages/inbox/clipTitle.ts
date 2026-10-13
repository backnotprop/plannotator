import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Hover text only where a name is cut: an element marked `data-clip` gets
 * its full text as its title while the pointer is over it, and only when it
 * is actually shortened (a subject that fits has no tooltip repeating it).
 * A FileName (`.ib-fname`) counts as cut when its first part is, and its
 * title is its whole name (`data-name`). Put this on a container's
 * `onPointerOver`: one listener for every row in it.
 */
export function titleIfClipped(event: ReactPointerEvent<HTMLElement>): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const el = target.closest<HTMLElement>('[data-clip]');
  if (!el) return;
  const part = el.classList.contains('ib-fname') ? el.querySelector<HTMLElement>('.ib-fname-h') : el;
  const cut = isClipped(el) || (part !== null && part !== el && isClipped(part));
  const text = el.dataset.name ?? el.textContent ?? '';
  if (cut && text) el.title = text;
  else el.removeAttribute('title');
}

function isClipped(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}
