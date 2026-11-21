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
  if (!chromiumEditing(doc.defaultView?.navigator)) return false;
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

/** What the engine check reads off `navigator` (User-Agent Client Hints are Chromium-only). */
export interface EditingEngineNavigator {
  userAgent?: string;
  userAgentData?: { brands?: ReadonlyArray<{ brand: string; version: string }> } | null;
}

/**
 * Only Chromium takes the edit path; elsewhere the caller writes the words as before (as 0.28.67 did everywhere).
 * In WebKit (Safari, iOS) the `execCommand` insertion merged with the typing before it and the earlier undo steps
 * were lost: one ⌘Z after `Run /dep` and a pick emptied the box (QA of 0.29.0's gate, Playwright's WebKit). Firefox
 * is not proved either way. Chromium is told by the "Chromium" brand of User-Agent Client Hints, else by `Chrome/`
 * in the UA string (Safari and Firefox carry none; Chrome on iOS is WebKit and says `CriOS/`).
 */
export function chromiumEditing(nav: EditingEngineNavigator | undefined | null): boolean {
  if (!nav) return false;
  if (nav.userAgentData?.brands?.some((b) => b.brand === 'Chromium')) return true;
  return /\bChrome\/\d+/.test(nav.userAgent ?? '');
}
