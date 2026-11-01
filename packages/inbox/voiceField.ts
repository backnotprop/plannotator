/**
 * The textarea as a dictation session sees it. Text goes in as if typed: the browser's own undo takes it back and the
 * host's `onChange` runs, so nothing here knows about drafts.
 */
import type { VoiceField } from './voiceSession';

/** The words, with the spaces this spot needs. */
export function spaced(before: string | undefined, after: string | undefined, words: string): string {
  let out = words;
  if (before && !/\s/.test(before)) out = ` ${out}`;
  if (after && !/[\s.,;:!?)]/.test(after)) out = `${out} `;
  return out;
}

/**
 * `touch`: never focus the field on a phone, or its keyboard comes up over the box; and the browser's insert needs
 * focus, so the words go in by range there.
 */
export function textareaField(textarea: HTMLTextAreaElement, touch: () => boolean): VoiceField {
  return {
    selection: () => ({ start: textarea.selectionStart, end: textarea.selectionEnd }),
    text: () => textarea.value,
    readOnly: () => textarea.readOnly,
    focus: () => {
      if (!touch()) textarea.focus({ preventScroll: true });
    },
    select: (start, end) => textarea.setSelectionRange(start, end),
    insert: (words) => {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const out = spaced(textarea.value[start - 1], textarea.value[end], words);
      let done = false;
      if (!touch() && typeof document.execCommand === 'function') {
        // One undo step. Focus goes back to wherever the person went meanwhile.
        const elsewhere = document.activeElement;
        textarea.focus({ preventScroll: true });
        done = document.execCommand('insertText', false, out);
        if (elsewhere instanceof HTMLElement && elsewhere !== textarea && elsewhere !== document.body) elsewhere.focus({ preventScroll: true });
      }
      if (!done) {
        // The prototype's setter, or React sees its own value and calls no onChange.
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, `${textarea.value.slice(0, start)}${out}${textarea.value.slice(end)}`);
        textarea.setSelectionRange(start + out.length, start + out.length);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return { start, end: start + out.length };
    },
    watch: (onCaret, onInput) => {
      const onSelection = () => {
        if (document.activeElement === textarea) onCaret();
      };
      document.addEventListener('selectionchange', onSelection);
      textarea.addEventListener('input', onInput);
      return () => {
        document.removeEventListener('selectionchange', onSelection);
        textarea.removeEventListener('input', onInput);
      };
    },
  };
}
