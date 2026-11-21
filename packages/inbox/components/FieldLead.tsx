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
    lead.style.top = `${Math.round(top)}px`;
    // How far a tap area may reach past the lead without leaving the first line: up into the field's top padding (a
    // quote line, when shown, sits above it), never down into the second line (phoneComposer.css reads both).
    lead.style.setProperty('--ib-lead-up', `${Math.max(0, above)}px`);
    lead.style.setProperty('--ib-lead-down', `${Math.max(0, (height - line) / 2) + 0.5}px`);
    if (rtl) {
      const scrollbar = Math.max(0, field.offsetWidth - field.clientWidth - px(style.borderLeftWidth) - px(style.borderRightWidth));
      lead.style.left = 'auto';
      lead.style.right = `${Math.round(wrapBox.right - fieldBox.right + px(style.borderRightWidth) + scrollbar + px(style.paddingRight))}px`;
    } else {
      lead.style.right = 'auto';
      lead.style.left = `${Math.round(fieldBox.left - wrapBox.left + px(style.borderLeftWidth) + px(style.paddingLeft))}px`;
    }
    wrap.style.setProperty('--ib-lead', `${Math.ceil(lead.getBoundingClientRect().width) + LEAD_GAP}px`);
  }, [rtl]);

  useLayoutEffect(() => {
    place();
  }, [place]);

  // The lead's width (another recipient, a name that gives way), the field's size and padding (a quote over the words,
  // the text size, a phone turned) and the field's own scroll move it.
  useEffect(() => {
    const lead = leadRef.current;
    const field = partsOf(lead)?.field;
    if (!lead || !field) return;
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : null;
    watch?.observe(lead);
    watch?.observe(field, { box: 'border-box' });
    field.addEventListener('scroll', place);
    return () => {
      watch?.disconnect();
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
