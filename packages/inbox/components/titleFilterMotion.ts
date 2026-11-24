/**
 * Filter by typing's motion (the motion study of 2026-11-24): the menu's row becomes the field, and the field folds
 * away. Reduced motion: none of it, the field is there or gone at once.
 *
 * - Open, 200 ms on the travel curve: a copy of the pressed row (its box, magnifier and label) flies from the menu to
 *   the field's place; on the way its fill fades and its corners square, "Title…" gives way to the muted placeholder,
 *   the violet line grows from the left and the × fades in. The list makes room on the same curve and time
 *   (inbox.css `.ib-tflt[data-enter]`). The real field, already focused, shows when the copy lands. A phone's row sits
 *   in a sheet at the bottom: there the field only eases in.
 * - Close, 180 ms on the same curve: a copy of the field, words and all, folds to nothing while its content fades
 *   (120 ms); the real field is gone at once, so the list is whole again under it.
 *
 * Only transforms of a copy outside React's tree, and one row's height: no row of the list is animated.
 */
const TRAVEL = 'cubic-bezier(0.32, 0.72, 0, 1)';
const CALM = 'cubic-bezier(0.25, 0.8, 0.25, 1)';
const OPEN_MS = 200;
const CLOSE_MS = 180;

export const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const canAnimate = (el: Element) => typeof (el as HTMLElement).animate === 'function' && !reducedMotion();

/** The pressed row: its box on screen and its words, until the field takes them. */
let from: { box: DOMRect; label: string; fill: string } | null = null;

/** The menu's row was pressed: where it was and its highlight, for the field to fly from. */
export function noteTravelFrom(row: HTMLElement | null) {
  from = row ? { box: row.getBoundingClientRect(), label: row.textContent ?? '', fill: getComputedStyle(row).backgroundColor } : null;
}

/** Flies the pressed row to `find` (the field's box), the field hidden until the copy lands. */
export function travelToField(find: HTMLElement, placeholder: string) {
  const start = from;
  from = null;
  const host = find.closest<HTMLElement>('.pn-inbox');
  if (!start || !host || !canAnimate(find)) return;
  const end = find.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = 'ib-tflt-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  const mark = find.querySelector('svg')?.cloneNode(true);
  if (mark) ghost.append(mark);
  const words = document.createElement('span');
  words.className = 'ib-tflt-gw';
  const label = Object.assign(document.createElement('span'), { className: 'ib-tflt-gl', textContent: start.label });
  const hint = Object.assign(document.createElement('span'), { className: 'ib-tflt-gp', textContent: placeholder });
  words.append(label, hint);
  const x = find.querySelector('.ib-lflt-clear')?.cloneNode(true) as HTMLElement | undefined;
  x?.removeAttribute('data-title-filter-close');
  x?.classList.add('ib-tflt-gx');
  const line = Object.assign(document.createElement('span'), { className: 'ib-tflt-gline' });
  ghost.append(words, ...(x ? [x] : []), line);
  host.append(ghost);
  // A transformed ancestor would place `position: fixed` against itself: measure where 0, 0 lands and count from there.
  const origin = ghost.getBoundingClientRect();
  const at = (box: DOMRect) => ({ left: `${box.left - origin.left}px`, top: `${box.top - origin.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  const timing = { duration: OPEN_MS, easing: TRAVEL, fill: 'both' as const };
  find.style.opacity = '0';
  const fly = ghost.animate(
    [
      { ...at(start.box), borderRadius: '6px', backgroundColor: start.fill },
      { offset: 0.2, backgroundColor: start.fill },
      { offset: 0.85, backgroundColor: 'transparent' },
      { ...at(end), borderRadius: '0px', backgroundColor: 'transparent' },
    ],
    timing,
  );
  label.animate([{ opacity: 1 }, { opacity: 0, offset: 0.4 }, { opacity: 0 }], timing);
  hint.animate([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], timing);
  line.animate([{ opacity: 0, transform: 'scaleX(0.25)' }, { opacity: 0, transform: 'scaleX(0.25)', offset: 0.2 }, { opacity: 1, offset: 0.35 }, { opacity: 1, transform: 'scaleX(1)' }], timing);
  x?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1 }], timing);
  const land = () => {
    ghost.remove();
    find.style.opacity = '';
  };
  Promise.resolve(fly.finished).then(land, land);
}

/** Folds a copy of the field (`box`, holding `text`) away in its place; the real one goes at once. */
export function foldField(box: HTMLElement, text: string) {
  if (!canAnimate(box) || !box.parentElement) return;
  const copy = box.cloneNode(true) as HTMLElement;
  copy.removeAttribute('data-enter');
  copy.removeAttribute('data-title-filter');
  copy.removeAttribute('role');
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  for (const el of copy.querySelectorAll('[data-title-filter-input], [data-title-filter-close]')) {
    el.removeAttribute('data-title-filter-input');
    el.removeAttribute('data-title-filter-close');
  }
  const input = copy.querySelector('input');
  if (input) input.value = text;
  copy.style.overflow = 'hidden';
  box.parentElement.insertBefore(copy, box);
  const height = box.getBoundingClientRect().height;
  const fold = copy.animate([{ height: `${height}px` }, { height: '0px' }], { duration: CLOSE_MS, easing: TRAVEL, fill: 'forwards' });
  copy.querySelector('.ib-lflt-find')?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: CALM, fill: 'forwards' });
  const gone = () => copy.remove();
  Promise.resolve(fold.finished).then(gone, gone);
}
