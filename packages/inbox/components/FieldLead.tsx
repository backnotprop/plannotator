/**
 * Something drawn at the start of a composer field's first line, the words flowing after it (the reply box's
 * recipient chip, approval "inbox-reply-target-chip", option B "A chip at the start of your words", 2026-11-20).
 *
 * It is not in the text: the field's first line is indented by its width (`--ib-lead`, read by inbox.css as the
 * `text-indent` of the textarea and of its painted mirror, so the two stay in register, and the caret helpers in
 * caretMenu.ts and hashtags.ts copy it), and it is laid over that indent. So Backspace at the start never reaches it,
 * the caret and a selection start after it, the placeholder starts after it, and later lines wrap under it. It sits
 * in the field's own box, before the textarea: it scrolls with the first line and comes before the words in the tab
 * order, and it is no part of the textarea's name.
 *
 * Each paragraph of the reply runs in its own direction (`unicode-bidi: plaintext`), and a browser indents a
 * right-to-left first paragraph at its right end, so there the lead moves to the right end too (`firstLineRtl`).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

/** The space between the lead and the first word (the approved mock's 8 px). */
const LEAD_GAP = 8;
/** The most of the first line the lead takes, and its widest (inbox.css falls back to the same, of the field's box). */
const LEAD_SHARE = 0.4;
const LEAD_MAX = 240;

// Strong right-to-left letters (Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, and their presentation
// forms), and any other letter as strong left-to-right: enough of the Unicode bidi rule P2 to find the first strong one.
const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]|\uD802[\uDC00-\uDFFF]|\uD803[\uDC00-\uDE7F]|\uD83A[\uDC00-\uDFFF]|\uD83B[\uDC00-\uDEFF]/;
const LETTER = /\p{L}/u;

/** Whether the words' first paragraph runs right to left: its first strong letter is a right-to-left one. */
export function firstLineRtl(text: string): boolean {
  for (const char of text) {
    if (char === '\n') return false;
    if (RTL.test(char)) return true;
    if (LETTER.test(char)) return false;
  }
  return false;
}

const px = (value: string) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The widest the lead may be, in px: 40% of the first line (the textarea's content box, between its paddings: the box
 * keeps 48 px at the right for its expand button, so 40% of the field's own box was more than 40% of the line), at most
 * 240 px. Null while the field is not laid out.
 */
export function leadMaxWidth(field: HTMLTextAreaElement): number | null {
  const style = (field.ownerDocument.defaultView ?? window).getComputedStyle(field);
  const line = field.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
  return line > 0 ? Math.floor(Math.min(LEAD_MAX, line * LEAD_SHARE)) : null;
}

/** Sets a style property only when it changes, so placing again after every render writes nothing new. */
function put(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

/** The field's box (the lead's parent) and its textarea, from the DOM: on the first commit neither parent's ref is set yet. */
function partsOf(lead: HTMLElement | null): { wrap: HTMLElement; field: HTMLTextAreaElement } | null {
  const wrap = lead?.parentElement;
  const field = wrap?.querySelector<HTMLTextAreaElement>('textarea');
  return wrap && field ? { wrap, field } : null;
}

export function FieldLead({ value, children }: { value: string; children: ReactNode }) {
  const leadRef = useRef<HTMLDivElement | null>(null);
  const rtl = firstLineRtl(value);
  const place = useCallback(() => {
    const lead = leadRef.current;
    const parts = partsOf(lead);
    if (!lead || !parts) return;
    const { wrap, field } = parts;
    const view = field.ownerDocument.defaultView ?? window;
    const style = view.getComputedStyle(field);
    const fieldBox = field.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    const line = px(style.lineHeight) || px(style.fontSize) * 1.2;
    const height = lead.offsetHeight;
    // On the first line's box, centred in it; with the field's own scroll (a field capped in height), up with the words.
    const above = px(style.borderTopWidth) + px(style.paddingTop) + (line - height) / 2;
    const top = fieldBox.top - wrapBox.top + above - field.scrollTop;
    put(lead, 'top', `${Math.round(top)}px`);
    if (rtl) {
      const scrollbar = Math.max(0, field.offsetWidth - field.clientWidth - px(style.borderLeftWidth) - px(style.borderRightWidth));
      put(lead, 'left', 'auto');
      put(lead, 'right', `${Math.round(wrapBox.right - fieldBox.right + px(style.borderRightWidth) + scrollbar + px(style.paddingRight))}px`);
    } else {
      put(lead, 'right', 'auto');
      put(lead, 'left', `${Math.round(fieldBox.left - wrapBox.left + px(style.borderLeftWidth) + px(style.paddingLeft))}px`);
    }
    const max = leadMaxWidth(field);
    if (max === null) lead.style.removeProperty('--ib-lead-max');
    else put(lead, '--ib-lead-max', `${max}px`);
    put(wrap, '--ib-lead', `${Math.ceil(lead.getBoundingClientRect().width) + LEAD_GAP}px`);
  }, [rtl]);

  // After every render: a quote line over the words changes the field's top padding and nothing else (its height can
  // stay at its least), so no size watch would see it. `put` writes only what changed.
  useLayoutEffect(() => {
    place();
  });

  // Between renders: the lead's width (another recipient, a name that gives way), the field's size (its border box as
  // it grows; its content box when the padding changes under a fixed height: the text size) and the
  // field's own scroll move it.
  useEffect(() => {
    const lead = leadRef.current;
    const field = partsOf(lead)?.field;
    if (!lead || !field) return;
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : null;
    const inner = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : null;
    watch?.observe(lead);
    watch?.observe(field, { box: 'border-box' });
    inner?.observe(field, { box: 'content-box' });
    field.addEventListener('scroll', place);
    return () => {
      watch?.disconnect();
      inner?.disconnect();
      field.removeEventListener('scroll', place);
    };
  }, [place]);
  // Gone (one agent left, the box closed): the first line is the field's own again.
  useEffect(() => {
    const wrap = leadRef.current?.parentElement;
    return () => {
      wrap?.style.removeProperty('--ib-lead');
    };
  }, []);

  return (
    <div className="ib-flead" ref={leadRef} data-field-lead={rtl ? 'rtl' : 'ltr'}>
      {children}
    </div>
  );
}
