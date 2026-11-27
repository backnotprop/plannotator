/**
 * Where the reply box's caret goes when the box takes focus. A box that comes back holding a draft has its caret at
 * the start (the field is drawn with its words), so a focus that does not place the caret itself (R, the message's
 * Reply arrow, Tab) would put the next typed key in front of the words.
 */
const placed = new WeakSet<HTMLTextAreaElement>();

function caretAtEnd(text: HTMLTextAreaElement): void {
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
  placed.add(text);
}

/**
 * Focus the box now, the caret after its words, so the very next key lands there (never a thread shortcut). Then, on
 * the next frame (a box opening now is drawn by then), again, and the words' end brought into view: the words scroll in
 * the box's capped region (approval "inbox-reply-box", D1), not in the field.
 */
export function focusReplyEnd(textRef: { readonly current: HTMLTextAreaElement | null }): void {
  if (textRef.current) caretAtEnd(textRef.current);
  requestAnimationFrame(() => {
    const text = textRef.current;
    if (!text) return;
    caretAtEnd(text);
    text.scrollTop = text.scrollHeight;
    const region = text.closest<HTMLElement>('[data-reply-scroll]');
    if (region) region.scrollTop += text.getBoundingClientRect().bottom - region.getBoundingClientRect().bottom;
  });
}

/**
 * The box's first focus since it was drawn: a caret still at the start of words is moved after them. A click or a tap
 * places the caret itself, after this.
 */
export function caretToEndOnFirstFocus(target: EventTarget, text: HTMLTextAreaElement | null): void {
  if (!text || target !== text || placed.has(text)) return;
  placed.add(text);
  if (text.value.length > 0 && text.selectionStart === 0 && text.selectionEnd === 0) text.setSelectionRange(text.value.length, text.value.length);
}
