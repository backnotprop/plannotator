/**
 * Where the skill picker sits when it opens at the caret (compose's message,
 * a tall field in a modal dialog). The picker is portaled into the dialog and
 * hangs off a box laid over the caret's line; this file measures that line
 * and keeps the box inside the part of the field that is on screen.
 *
 * Why not the field's own box: the menu is `absolute` against its wrapper, so
 * in a tall field it opened under the whole field, inside `.ib-cp-body`
 * (a scroll container), and the dialog's footer covered it.
 */

export interface VerticalBox {
  top: number;
  bottom: number;
}

export interface AnchorBox extends VerticalBox {
  left: number;
  width: number;
}

/**
 * The caret's line in a textarea, in viewport coordinates: a hidden mirror
 * with the textarea's metrics lays out the text before the caret and a span
 * holding the rest (so the line wraps exactly as the textarea's does), and the
 * span's top is the line's top. Null when the textarea is not laid out.
 */
export function caretLineRect(textarea: HTMLTextAreaElement, position = textarea.selectionStart ?? textarea.value.length): VerticalBox | null {
  const doc = textarea.ownerDocument;
  const view = doc.defaultView;
  if (!view) return null;
  const rect = textarea.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const style = view.getComputedStyle(textarea);
  const mirror = doc.createElement('div');
  const copy = [
    'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'fontFeatureSettings',
    'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize', 'direction',
  ] as const;
  for (const key of copy) (mirror.style as unknown as Record<string, string>)[key] = style[key] as string;
  const borderX = px(style.borderLeftWidth) + px(style.borderRightWidth);
  // clientWidth leaves out a classic scrollbar, so the mirror wraps where the textarea does.
  mirror.style.boxSizing = 'border-box';
  mirror.style.width = `${textarea.clientWidth + borderX}px`;
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.wordBreak = style.wordBreak;
  mirror.style.overflow = 'hidden';
  mirror.style.height = 'auto';
  mirror.setAttribute('aria-hidden', 'true');
  const value = textarea.value;
  const at = Math.max(0, Math.min(position, value.length));
  mirror.textContent = value.slice(0, at);
  const marker = doc.createElement('span');
  marker.textContent = value.slice(at) || '.';
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);
  try {
    const lineHeight = px(style.lineHeight) || px(style.fontSize) * 1.2;
    const top = rect.top + px(style.borderTopWidth) + marker.offsetTop - textarea.scrollTop;
    return { top, bottom: top + lineHeight };
  } finally {
    mirror.remove();
  }
}

/**
 * The part of `el` on screen: its box cut by every ancestor that clips
 * (overflow other than visible) below `stopAt`.
 */
export function visibleBox(el: Element, stopAt: Element | null): VerticalBox & { left: number; right: number } {
  const r = el.getBoundingClientRect();
  const box = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  const view = el.ownerDocument.defaultView;
  for (let node = el.parentElement; node && node !== stopAt; node = node.parentElement) {
    const style = view?.getComputedStyle(node);
    if (!style) break;
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const c = node.getBoundingClientRect();
    box.top = Math.max(box.top, c.top);
    box.bottom = Math.min(box.bottom, c.bottom);
    box.left = Math.max(box.left, c.left);
    box.right = Math.min(box.right, c.right);
  }
  return box;
}

/**
 * The box the picker hangs off: the caret's line, held inside the visible
 * part of the field (a line scrolled out of view pins to the field's edge, so
 * the menu stays next to the field), across the field's width. Pure.
 */
export function caretAnchor(line: VerticalBox, visible: VerticalBox, field: { left: number; width: number }): AnchorBox {
  const height = Math.max(0, line.bottom - line.top);
  const lo = visible.top;
  const hi = Math.max(lo, visible.bottom - height);
  const top = Math.min(Math.max(line.top, lo), hi);
  return { top, bottom: top + Math.min(height, Math.max(0, visible.bottom - visible.top)), left: field.left, width: field.width };
}

/**
 * The part of the page the person can see, in the coordinates
 * getBoundingClientRect uses: the visual viewport. On iOS with the keyboard up
 * it is shorter than the layout viewport (`innerHeight` can still read the
 * full height), so a list sized against `innerHeight` runs under the keyboard.
 */
export function seenBox(view: Window = window): VerticalBox {
  const vv = view.visualViewport;
  if (vv && Number.isFinite(vv.height) && Number.isFinite(vv.offsetTop) && vv.height > 0) return { top: vv.offsetTop, bottom: vv.offsetTop + vv.height };
  // No usable reading (none at all, or one caught mid-rotation): the layout viewport.
  const height = Number.isFinite(view.innerHeight) && view.innerHeight > 0 ? view.innerHeight : view.document.documentElement.clientHeight;
  return { top: 0, bottom: height };
}

/** The overlap of two vertical boxes (a zero-height box at `a`'s clamped top when they miss). Pure. */
export function overlapBox(a: VerticalBox, b: VerticalBox): VerticalBox {
  const top = Math.max(a.top, b.top);
  return { top, bottom: Math.max(top, Math.min(a.bottom, b.bottom)) };
}

/**
 * The room a composer's skill list may use: what the person sees, under the
 * thread's header when the field is in a thread (the reply box, New message),
 * so the list never opens under, or over, the header's Back and actions.
 */
export function skillListRoom(field: Element): VerticalBox {
  const view = field.ownerDocument.defaultView ?? window;
  const seen = seenBox(view);
  const head = field.closest('.ib-pane')?.querySelector(':scope > .ib-phead');
  const r = head?.getBoundingClientRect();
  if (!r || r.height === 0) return seen;
  return overlapBox(seen, { top: r.bottom, bottom: seen.bottom });
}

/** A phone's list: at most 4½ rows of 44 px and 40% of what is visible, never under 1½ rows. Pure. */
export const PHONE_SKILL_LIST_HEIGHT = 198;
export function phoneSkillListHeight(seenHeight: number): number {
  return Math.min(PHONE_SKILL_LIST_HEIGHT, Math.max(66, Math.round(seenHeight * 0.4)));
}

/**
 * The box the list hangs off for a field (not the caret): the field's box,
 * cut to the part on screen, so a field half scrolled out of a scrolling foot
 * keeps the list against its visible edge. `gap` widens the box upward: the
 * list keeps the field's former distance above it. Pure but for the reading.
 */
export function fieldAnchor(field: Element, stopAt: Element | null, gap = 0, widen = 0): AnchorBox {
  const r = field.getBoundingClientRect();
  const visible = visibleBox(field, stopAt);
  const top = Math.min(Math.max(r.top, visible.top), visible.bottom);
  const bottom = Math.max(top, Math.min(r.bottom, visible.bottom));
  return { top: top - gap, bottom, left: r.left - widen, width: r.width + 2 * widen };
}

function px(value: string | null | undefined): number {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}
