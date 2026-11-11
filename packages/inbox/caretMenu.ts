// The picker is portaled into the dialog and hangs off a box laid over the caret's line.
// Anchoring on the field's own box opened it under the whole field, where the dialog footer covered it.

export interface VerticalBox {
  top: number;
  bottom: number;
}

export interface AnchorBox extends VerticalBox {
  left: number;
  width: number;
}

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

export function caretAnchor(line: VerticalBox, visible: VerticalBox, field: { left: number; width: number }): AnchorBox {
  const height = Math.max(0, line.bottom - line.top);
  const lo = visible.top;
  const hi = Math.max(lo, visible.bottom - height);
  const top = Math.min(Math.max(line.top, lo), hi);
  return { top, bottom: top + Math.min(height, Math.max(0, visible.bottom - visible.top)), left: field.left, width: field.width };
}

/** The visual viewport: on iOS with the keyboard up it is shorter than the layout viewport (`innerHeight` can still read the full height). */
export function seenBox(view: Window = window): VerticalBox {
  const vv = view.visualViewport;
  if (vv && Number.isFinite(vv.height) && Number.isFinite(vv.offsetTop) && vv.height > 0) return { top: vv.offsetTop, bottom: vv.offsetTop + vv.height };
  const height = Number.isFinite(view.innerHeight) && view.innerHeight > 0 ? view.innerHeight : view.document.documentElement.clientHeight;
  return { top: 0, bottom: height };
}

export function overlapBox(a: VerticalBox, b: VerticalBox): VerticalBox {
  const top = Math.max(a.top, b.top);
  return { top, bottom: Math.max(top, Math.min(a.bottom, b.bottom)) };
}

export function skillListRoom(field: Element): VerticalBox {
  const view = field.ownerDocument.defaultView ?? window;
  const seen = seenBox(view);
  const head = field.closest('.ib-pane')?.querySelector(':scope > .ib-phead');
  const r = head?.getBoundingClientRect();
  if (!r || r.height === 0) return seen;
  return overlapBox(seen, { top: r.bottom, bottom: seen.bottom });
}

/** The list is drawn at the Inbox's root, above the whole shell, so without this check it floated over whatever covered its field. */
export function fieldInSight(field: HTMLElement, surface: Element, stopAt: Element | null, own: Element | null): boolean {
  const doc = field.ownerDocument;
  if (doc.activeElement !== field) return false;
  if (field.closest('[inert]')) return false;
  const r = field.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return !(doc.documentElement.getBoundingClientRect().width > 0);
  const shown = overlapBox(visibleBox(field, stopAt), seenBox(doc.defaultView ?? window));
  if (shown.bottom - shown.top < 1) return false;
  const hit = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(r.left + r.width / 2, (shown.top + shown.bottom) / 2) : null;
  if (!hit) return true;
  return surface.contains(hit) || (own !== null && own.contains(hit));
}

export const PHONE_SKILL_LIST_HEIGHT = 198;
export function phoneSkillListHeight(seenHeight: number): number {
  return Math.min(PHONE_SKILL_LIST_HEIGHT, Math.max(66, Math.round(seenHeight * 0.4)));
}

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
