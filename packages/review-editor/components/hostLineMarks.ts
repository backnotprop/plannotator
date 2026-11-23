/**
 * A host's mark at the right edge of a line of the diff (the Inbox's PR page: the risk bars, approval
 * "review-risk-bars"). The mark is a real `<button>`, the marked line's last child inside the file's shadow root, so
 * it takes hover, focus, clicks and an accessible name, and the host can open a card on it. Pierre has no slot for an
 * element at a line's end: its line annotations are rows under the line (what the mark replaces) and its gutter
 * utility is one element that follows the hovered line in the gutter. So the view keeps one button per marked line
 * itself (`keepHostLineMarks`), put back whenever Pierre draws the line again.
 *
 * Its place is CSS (`HOST_LINE_MARKS_CSS`, in the shadow root through Pierre's `unsafeCSS`), so it never covers code:
 *
 * - The mark is a box `LINE_MARK_WIDTH` wide and one line tall at the column's right edge, filled with the line's own
 *   background (`inherit`: added, removed, selected, as the line is), the host's `paint` on top.
 * - Wrapped lines (`data-overflow="wrap"`): the line keeps that much room free at its end, so its text wraps before
 *   the mark; the mark sits on the line's first row.
 * - Lines that scroll sideways (`data-overflow="scroll"`): the mark follows the line's text and sticks to the column's
 *   visible right edge (`position: sticky`, between 0 from the right and the column's width minus its own from the
 *   left; the width is `100cqi` of the column, which Pierre makes a size container under line-info separators, as the
 *   PR page draws them), so on that line the code ends where the mark begins, like the column's own edge; the
 *   mark adds its width to the line, so scrolled all the way, the line's last character sits clear of it.
 *
 * Split and unified views, old and new sides: the line is found by its number on its side.
 */

export interface HostLineMark {
  /** The host's name for the mark, unique on the page: what `OnHostLineMark` hands back. */
  id: string;
  filePath: string;
  side: 'old' | 'new';
  line: number;
  /** The mark's accessible name. */
  label: string;
  /**
   * The mark's look: CSS declarations for its box (`LINE_MARK_WIDTH` × one line), backgrounds only (`background-image`,
   * `-size`, `-position`); its fill under them is the line's.
   */
  paint: string;
  /**
   * The mark opens a popup of this kind (`aria-haspopup`); its `aria-expanded` starts false and is the host's to set
   * while the popup is open (the button is what `OnHostLineMark` hands it).
   */
  popup?: 'dialog';
}

/** What happened on a mark: the pointer came or went, keyboard focus came or went, or it was pressed (click, tap, key). */
export type HostLineMarkEvent = 'enter' | 'leave' | 'focus' | 'blur' | 'press';

/** The host hears its marks: `focus` only for focus no press brought (the keyboard's), `enter`/`leave` never for touch. */
export type OnHostLineMark = (id: string, event: HostLineMarkEvent, button: HTMLButtonElement, related: EventTarget | null) => void;

export const NO_HOST_LINE_MARKS: readonly HostLineMark[] = [];

/** The mark's width in px: the room the line keeps free at its right edge. */
export const LINE_MARK_WIDTH = 24;

/** The attribute a mark's button carries (its side and line, `new:12`). */
export const HOST_LINE_MARK_ATTR = 'data-host-line-mark';

/** The line on its side, in both views (split: its column; unified: an old line is a removed one or context's other number). */
export function hostLineSelectors(side: 'old' | 'new', line: number): string[] {
  const n = Math.trunc(line);
  return side === 'new'
    ? [`[data-additions] [data-line="${n}"]`, `[data-unified] [data-line="${n}"]:not([data-line-type="change-deletion"])`]
    : [`[data-deletions] [data-line="${n}"]`, `[data-unified] [data-line-type="change-deletion"][data-line="${n}"]`, `[data-unified] [data-alt-line="${n}"]`];
}

const W = `${LINE_MARK_WIDTH}px`;
const MARKED = `[data-line]:has(> [${HOST_LINE_MARK_ATTR}])`;
const BOX = `width: ${W}; height: 1lh; margin: 0; padding: 0; border: 0; border-radius: 0; box-sizing: border-box; font: inherit; color: inherit; appearance: none; cursor: pointer; background-color: inherit; background-repeat: no-repeat; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent;`;

/** The marks' CSS, the same for every mark (each one's look is its own `paint`). */
export const HOST_LINE_MARKS_CSS = `
[data-overflow="scroll"] ${MARKED} { padding-inline-end: 0; }
[data-overflow="scroll"] [${HOST_LINE_MARK_ATTR}] { display: inline-block; vertical-align: top; position: sticky; right: 0; left: calc(100cqi - ${W}); ${BOX} }
[data-overflow="wrap"] ${MARKED} { padding-inline-end: ${W}; }
[data-overflow="wrap"] [${HOST_LINE_MARK_ATTR}] { display: block; position: absolute; top: 0; right: 0; ${BOX} }
[${HOST_LINE_MARK_ATTR}]:focus { outline: none; }
[${HOST_LINE_MARK_ATTR}]:focus-visible { outline: 2px solid color-mix(in oklch, var(--primary, #3b82f6) 70%, transparent); outline-offset: -2px; }
`;

/** Each button's mark id (a line drawn again gets the same button back, so a card anchored to it stays). */
const idOf = new WeakMap<HTMLButtonElement, string>();
const paintOf = new WeakMap<HTMLButtonElement, string>();

interface Keeper {
  marks: readonly HostLineMark[];
  onMark: { current: OnHostLineMark | undefined };
  buttons: Map<string, HTMLButtonElement>;
  observer: MutationObserver;
}

const keepers = new WeakMap<ShadowRoot, Keeper>();

function makeButton(mark: HostLineMark, keeper: Keeper): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  const id = mark.id;
  idOf.set(button, id);
  const tell = (event: HostLineMarkEvent, related: EventTarget | null = null) => keeper.onMark.current?.(id, event, button, related);
  button.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'touch') tell('enter', e.relatedTarget);
  });
  button.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch') tell('leave', e.relatedTarget);
  });
  // Focus that a pointer's press brought is the press's (`press` follows); any other is keyboard focus.
  let pressing = false;
  button.addEventListener('focus', (e) => {
    if (!pressing) tell('focus', e.relatedTarget);
  });
  button.addEventListener('blur', (e) => {
    pressing = false;
    tell('blur', e.relatedTarget);
  });
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    pressing = false;
    tell('press');
  });
  // A press on the mark is the mark's: never the diff's line selection or text drag under it.
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'touchstart'] as const) {
    button.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type === 'pointerdown' || type === 'mousedown' || type === 'touchstart') pressing = true;
    });
  }
  return button;
}

function dress(button: HTMLButtonElement, mark: HostLineMark): void {
  const at = `${mark.side}:${Math.trunc(mark.line)}`;
  if (button.getAttribute(HOST_LINE_MARK_ATTR) !== at) button.setAttribute(HOST_LINE_MARK_ATTR, at);
  if (button.getAttribute('aria-label') !== mark.label) button.setAttribute('aria-label', mark.label);
  if (mark.popup) {
    if (button.getAttribute('aria-haspopup') !== mark.popup) button.setAttribute('aria-haspopup', mark.popup);
    if (!button.hasAttribute('aria-expanded')) button.setAttribute('aria-expanded', 'false');
  } else if (button.hasAttribute('aria-haspopup')) {
    button.removeAttribute('aria-haspopup');
    button.removeAttribute('aria-expanded');
  }
  if (paintOf.get(button) !== mark.paint) {
    paintOf.set(button, mark.paint);
    button.style.cssText = mark.paint;
  }
}

/** Puts each mark's button on its line, takes away any other; touches nothing already right (so it settles). */
function apply(root: ShadowRoot, keeper: Keeper): void {
  const want = new Map<Element, HostLineMark>();
  // One line per mark (its first match), one mark per line: a button lives in one place, so nothing moves it back and forth.
  const placed = new Set<string>();
  for (const mark of keeper.marks) {
    if (placed.has(mark.id)) continue;
    const line = hostLineSelectors(mark.side, mark.line)
      .map((selector) => root.querySelector(selector))
      .find((found) => found && !want.has(found));
    if (!line) continue;
    want.set(line, mark);
    placed.add(mark.id);
  }
  const ids = new Set(keeper.marks.map((mark) => mark.id));
  for (const button of root.querySelectorAll<HTMLButtonElement>(`[${HOST_LINE_MARK_ATTR}]`)) {
    const id = idOf.get(button);
    const line = button.parentElement;
    if (!id || keeper.buttons.get(id) !== button || !ids.has(id) || !line || want.get(line)?.id !== id) button.remove();
  }
  for (const [line, mark] of want) {
    let button = keeper.buttons.get(mark.id);
    if (!button) {
      button = makeButton(mark, keeper);
      keeper.buttons.set(mark.id, button);
    }
    dress(button, mark);
    if (button.parentElement !== line || line.lastElementChild !== button) line.appendChild(button);
  }
  for (const id of keeper.buttons.keys()) if (!ids.has(id)) keeper.buttons.delete(id);
}

/**
 * Keeps the marks' buttons on their lines in one file's diff (`root`, the file's shadow root; `marks`, that file's),
 * and again each time Pierre draws its lines. No marks: takes any away and stops watching.
 */
export function keepHostLineMarks(root: ShadowRoot, marks: readonly HostLineMark[], onMark: OnHostLineMark | undefined): void {
  let keeper = keepers.get(root);
  if (marks.length === 0) {
    if (keeper) dropHostLineMarks(root);
    return;
  }
  if (!keeper) {
    const made: Keeper = { marks, onMark: { current: onMark }, buttons: new Map(), observer: new MutationObserver(() => apply(root, made)) };
    keeper = made;
    keepers.set(root, keeper);
    keeper.observer.observe(root, { childList: true, subtree: true });
  }
  keeper.marks = marks;
  keeper.onMark.current = onMark;
  apply(root, keeper);
}

/** Takes a file's marks away (the view let its element go). */
export function dropHostLineMarks(root: ShadowRoot): void {
  const keeper = keepers.get(root);
  if (!keeper) return;
  keeper.observer.disconnect();
  keepers.delete(root);
  for (const button of keeper.buttons.values()) button.remove();
}
