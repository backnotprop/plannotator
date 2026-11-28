/**
 * Words the page writes into a text field the person is typing in (a picked `/skill`, `$skill` or `@name`, a command
 * taking its typed trigger out), written as the browser's own edit so its undo stays true.
 *
 * Why: a controlled field's new words written as `field.value` (React's write for a `setText`) change the text
 * outside the browser's undo stack. Chrome keeps the steps it recorded before (the typing, a deletion) and on ⌘Z
 * replays them onto words they no longer describe: type `alpha beta gamma`, select all, Backspace, type `Run /dep`,
 * pick `deploy-preview`, ⌘Z three times, and the field read `Run /deploy-preview alpha beta gamma`. Since the
 * textarea's text child stopped being rewritten on every key (ComposerTokenTextarea's `defaultValue=""`), Chrome
 * keeps one typing run open, so such a write lands inside it.
 *
 * `execCommand('insertText')` over the replaced range records the change as an edit: ⌘Z takes back the pick
 * alone, then the typing before it, and ⌘⇧Z puts them back. The typing run is ended before and after
 * (`endTypingRun`), so the pick is its own step, not part of the keys typed around it.
 */
import { endTypingRun, type PlainTextField } from './pasteInsert';

/**
 * Replaces `[from, to)` of a focused field's words with `insert` as one undoable edit; the field's `input` event
 * runs the host's onChange as for typing, and the caret ends after `insert`. False when it could not (the field
 * is not focused, no `execCommand`, or the words came out different): the caller writes the words itself, as
 * before. Never takes focus.
 */
export function replaceUndoably(field: PlainTextField, from: number, to: number, insert: string): boolean {
  const doc = field.ownerDocument;
  if (doc.activeElement !== field || typeof doc.execCommand !== 'function') return false;
  const before = field.value;
  if (from < 0 || to < from || to > before.length) return false;
  const expected = before.slice(0, from) + insert + before.slice(to);
  if (expected === before) return true;
  try {
    // Setting the selection also ends the typing run that is open (see endTypingRun).
    field.setSelectionRange(from, to);
    const done = insert ? doc.execCommand('insertText', false, insert) : doc.execCommand('delete', false);
    endTypingRun(field);
    return done === true && field.value === expected;
  } catch {
    return false;
  }
}
