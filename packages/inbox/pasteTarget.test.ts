/**
 * A ⌘V aimed at nothing goes to the text field the person was writing in
 * (pasteTarget.ts). Dictation apps (Hex and others) insert text with a
 * synthetic ⌘V; in the Inbox focus often leaves the field without the person
 * noticing (a click on a question's choice, on the message text, on a chip),
 * and the paste then landed nowhere.
 *
 * Proved here on the real handler, with several kinds of field (a textarea
 * like the reply box, a text input like a question's Other, a contenteditable,
 * a field inside a modal dialog like compose): focus comes back, with the
 * caret where it was (a selected range collapsed to its end), before the
 * browser pastes; a paste already aimed at a field, a frame, a field that is
 * gone, disabled, read-only or hidden, one behind a modal dialog, a
 * full-screen file or a guided review, or one with something drawn over it,
 * is left alone; other chords (the ⌘K, ⌘D and ⌘C that sit on V's key on
 * Dvorak, Colemak-DH and Workman included) are untouched and the keydown is
 * never cancelled.
 *
 * The whole window in a real Chromium (the reply box, a question card's note,
 * compose): tests/e2e/inbox-dictation-paste.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';

const hasDom = typeof document !== 'undefined';
const { installPasteFollowsField, isPasteKey } = (hasDom ? await import('./pasteTarget') : {}) as typeof import('./pasteTarget');

const mac = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey;
let uninstall: (() => void) | null = null;

beforeEach(() => {
  if (!hasDom) return;
  uninstall = installPasteFollowsField(window, mac);
});
afterEach(() => {
  if (!hasDom) return;
  uninstall?.();
  uninstall = null;
  // A selection a test made must not decide the next test's paste.
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

/** A ⌘V as Chrome hands it to the page: keydown Meta, then keydown V with metaKey. Returns the V keydown. */
function commandV(init: KeyboardEventInit = {}): KeyboardEvent {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true, bubbles: true, cancelable: true }));
  const v = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', metaKey: true, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(v);
  return v;
}

/** Build a page; every element "laid out" (happy-dom draws nothing, so client rects are stubbed per element). */
function page(html: string): void {
  document.body.innerHTML = html;
  for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
    if (el.hasAttribute('data-hidden')) continue;
    el.getClientRects = () => [{ x: 0, y: 0, width: 10, height: 10 }] as unknown as DOMRectList;
  }
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

test.skipIf(!hasDom)('isPasteKey: the platform modifier with V, Shift allowed; nothing else', () => {
  const base = { key: 'v', code: 'KeyV', metaKey: true, ctrlKey: false, altKey: false, isComposing: false };
  expect(isPasteKey(base, mac)).toBe(true);
  expect(isPasteKey({ ...base, key: 'V' }, mac)).toBe(true);
  // Another keyboard layout: the key's name differs, the physical key is V.
  expect(isPasteKey({ ...base, key: 'м' }, mac)).toBe(true);
  expect(isPasteKey({ ...base, metaKey: false }, mac)).toBe(false);
  expect(isPasteKey({ ...base, metaKey: false, ctrlKey: true }, mac)).toBe(false);
  expect(isPasteKey({ ...base, altKey: true }, mac)).toBe(false);
  expect(isPasteKey({ ...base, isComposing: true }, mac)).toBe(false);
  expect(isPasteKey({ ...base, key: 'c', code: 'KeyC' }, mac)).toBe(false);
});

test.skipIf(!hasDom)('isPasteKey on Latin layouts that move V: the letter decides, never the physical key', () => {
  const base = { metaKey: true, ctrlKey: false, altKey: false, isComposing: false };
  // The key in QWERTY's V place types another letter: ⌘ with it is that letter's command.
  expect(isPasteKey({ ...base, key: 'k', code: 'KeyV' }, mac)).toBe(false); // Dvorak ⌘K
  expect(isPasteKey({ ...base, key: 'd', code: 'KeyV' }, mac)).toBe(false); // Colemak-DH ⌘D
  expect(isPasteKey({ ...base, key: 'c', code: 'KeyV' }, mac)).toBe(false); // Workman ⌘C
  // Their V sits elsewhere, and ⌘ with it pastes.
  expect(isPasteKey({ ...base, key: 'v', code: 'Period' }, mac)).toBe(true); // Dvorak
  expect(isPasteKey({ ...base, key: 'v', code: 'KeyB' }, mac)).toBe(true); // Colemak-DH, Workman
  // No Latin letter on the key (Cyrillic, Greek): its place decides.
  expect(isPasteKey({ ...base, key: 'м', code: 'KeyV' }, mac)).toBe(true);
  expect(isPasteKey({ ...base, key: 'ω', code: 'KeyV' }, mac)).toBe(true);
  expect(isPasteKey({ ...base, key: 'с', code: 'KeyC' }, mac)).toBe(false);
});

test.skipIf(!hasDom)('a range selected before focus left collapses to its end: the dictation replaces nothing', () => {
  page(`<textarea id="reply"></textarea><label><input id="choice" type="radio" name="q"> Retry</label>`);
  const reply = $<HTMLTextAreaElement>('#reply');
  reply.focus();
  reply.value = 'one two three';
  reply.setSelectionRange(4, 7, 'forward'); // "two", selected, then the person picks a choice
  $<HTMLInputElement>('#choice').focus();
  commandV();
  expect(document.activeElement).toBe(reply);
  expect([reply.selectionStart, reply.selectionEnd]).toEqual([7, 7]);

  // A backward selection collapses to its end too (the larger offset).
  reply.setSelectionRange(0, 3, 'backward');
  $<HTMLInputElement>('#choice').focus();
  commandV();
  expect([reply.selectionStart, reply.selectionEnd]).toEqual([3, 3]);
});

test.skipIf(!hasDom)('a cover over the thread: a full-screen file or a guided review hides the reply box', () => {
  for (const cover of ['<div class="ib-view ib-full"><button id="b">x</button></div>', '<div class="ib-viewer"><button id="b">x</button></div>']) {
    page(`<section><textarea id="reply"></textarea></section>${cover}`);
    $<HTMLTextAreaElement>('#reply').focus();
    $<HTMLButtonElement>('#b').focus();
    commandV();
    expect(document.activeElement).toBe($('#b'));
  }
  // A file beside the thread (not full screen) covers nothing.
  page(`<section><textarea id="reply"></textarea></section><div class="ib-view"><button id="b">x</button></div>`);
  $<HTMLTextAreaElement>('#reply').focus();
  $<HTMLButtonElement>('#b').focus();
  commandV();
  expect(document.activeElement).toBe($('#reply'));
  // A field inside the full-screen file (a comment box on it) is reachable.
  page(`<div class="ib-view ib-full"><textarea id="comment"></textarea><button id="b">x</button></div>`);
  $<HTMLTextAreaElement>('#comment').focus();
  $<HTMLButtonElement>('#b').focus();
  commandV();
  expect(document.activeElement).toBe($('#comment'));
});

test.skipIf(!hasDom)('a box portaled over a full-screen file (a comment box) takes the paste when it is drawn on top', () => {
  // The comment box is portaled to the page's end, outside the full-screen file it belongs to.
  page(`<section><textarea id="reply"></textarea></section><div class="ib-view ib-full"><button id="tile">x</button></div><div id="popover"><textarea id="comment"></textarea><button id="cancel">Cancel</button></div>`);
  const comment = $<HTMLTextAreaElement>('#comment');
  const reply = $<HTMLTextAreaElement>('#reply');
  const saved = document.elementFromPoint;
  try {
    // The hit test sees the comment box on top, and the reply box under the file.
    let onTop: Element = comment;
    document.elementFromPoint = () => onTop;
    reply.focus();
    comment.focus();
    $<HTMLButtonElement>('#cancel').focus();
    commandV();
    expect(document.activeElement).toBe(comment);
    // The comment box closed: the reply box under the file is what is left, and it is covered.
    comment.remove();
    $<HTMLButtonElement>('#cancel').focus();
    onTop = $('#tile');
    commandV();
    expect(document.activeElement).toBe($('#cancel'));
  } finally {
    document.elementFromPoint = saved;
  }
  // Without a hit test the browser cannot say the box is on top: a field outside the cover is refused.
  page(`<div class="ib-viewer"><button id="b">x</button></div><textarea id="palette"></textarea>`);
  $<HTMLTextAreaElement>('#palette').focus();
  $<HTMLButtonElement>('#b').focus();
  commandV();
  expect(document.activeElement).toBe($('#b'));
});

test.skipIf(!hasDom)('several fields remembered: one that went away (search, closed) leaves the one before it', () => {
  page(`<textarea id="reply"></textarea><dialog id="palette"><input id="search" type="search"></dialog><label><input id="choice" type="radio" name="q"> Retry</label>`);
  const reply = $<HTMLTextAreaElement>('#reply');
  reply.focus();
  reply.value = 'Start. ';
  reply.setSelectionRange(7, 7);
  // Search opens over the window and takes focus; Escape closes it.
  const palette = $<HTMLDialogElement>('#palette');
  palette.setAttribute('open', '');
  $<HTMLInputElement>('#search').focus();
  palette.removeAttribute('open');
  palette.remove();
  $<HTMLInputElement>('#choice').focus();
  commandV();
  expect(document.activeElement).toBe(reply);
  expect([reply.selectionStart, reply.selectionEnd]).toEqual([7, 7]);
});

/** Select characters [start, end) of an element's first text node, as a drag or a double-click would. */
function selectText(el: HTMLElement, start: number, end: number): Selection {
  const range = document.createRange();
  range.setStart(el.firstChild!, start);
  range.setEnd(el.firstChild!, end);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

test.skipIf(!hasDom)('text selected in an attached file to comment on: the paste is not redirected', () => {
  page(`<textarea id="reply"></textarea><section class="ib-view"><p id="text">The plan says retry three times.</p></section><button id="b">x</button>`);
  $<HTMLTextAreaElement>('#reply').focus();
  $<HTMLButtonElement>('#b').focus();
  const selection = selectText($('#text'), 4, 8);
  commandV();
  expect(document.activeElement).toBe($('#b'));
  expect(selection.toString()).toBe('plan');
  // Once the selection is gone, the paste follows the reply box again.
  selection.removeAllRanges();
  commandV();
  expect(document.activeElement).toBe($('#reply'));
});

test.skipIf(!hasDom)("code selected in a guided review (inside its diff's shadow root) keeps the paste out of a comment box left open", () => {
  page(`
    <textarea id="reply"></textarea>
    <div class="ib-viewer">
      <div class="review-toolbar"><textarea id="guide-comment"></textarea></div>
      <div id="diff"><diffs-container id="host"></diffs-container></div>
    </div>
  `);
  const code = $('#host').attachShadow({ mode: 'open' });
  code.innerHTML = '<pre><code><span id="line">const retryWithSameKey = true;</span></code></pre>';
  const comment = $<HTMLTextAreaElement>('#guide-comment');
  $<HTMLTextAreaElement>('#reply').focus();
  comment.focus();
  comment.blur(); // the reviewer leaves the inline comment open and selects other code
  // What headless Chromium and WebKit report for a selection inside the shadow root: on the document
  // it is collapsed, anchored at the shadow host's parent, yet toString() holds the selected words.
  const getSelection = document.getSelection.bind(document);
  const shadowSelection = {
    rangeCount: 1,
    isCollapsed: true,
    anchorNode: $('#diff'),
    toString: () => 'retryWithSameKey',
  } as unknown as Selection;
  document.getSelection = () => shadowSelection;
  try {
    commandV();
    expect(document.activeElement).not.toBe(comment);
    expect(document.activeElement).not.toBe($('#reply'));
    // The same report outside a guided review or a file view (a word in a thread message) does not count.
    document.getSelection = () => ({ ...shadowSelection, anchorNode: document.body, toString: () => 'retryWithSameKey' }) as unknown as Selection;
    $('.ib-viewer').remove();
    commandV();
    expect(document.activeElement).toBe($('#reply'));
  } finally {
    document.getSelection = getSelection;
  }
  // Text selected in the guide's light DOM (a section's overview) counts too.
  page(`<textarea id="reply"></textarea><div class="ib-viewer"><p id="overview">Retry with the same key.</p></div><button id="b">x</button>`);
  $<HTMLTextAreaElement>('#reply').focus();
  $<HTMLButtonElement>('#b').focus();
  selectText($('#overview'), 0, 5);
  commandV();
  expect(document.activeElement).toBe($('#b'));
});

test.skipIf(!hasDom)('a word selected in a thread message or a choice label (double-click) does not turn the paste off', () => {
  page(`
    <textarea id="reply"></textarea>
    <article class="ib-message"><p id="message">Retry with the same idempotency key.</p></article>
    <label><input id="choice" type="radio" name="q"> <span id="label">Fail the job</span></label>
  `);
  const reply = $<HTMLTextAreaElement>('#reply');
  reply.focus();
  // A word double-clicked in the agent's message.
  $<HTMLInputElement>('#choice').focus();
  selectText($('#message'), 0, 5); // "Retry"
  commandV();
  expect(document.activeElement).toBe(reply);
  // A word double-clicked in a choice's label.
  $<HTMLInputElement>('#choice').focus();
  selectText($('#label'), 0, 4); // "Fail"
  commandV();
  expect(document.activeElement).toBe(reply);
});

test.skipIf(!hasDom)('every selection toolbar is checked, not only the first: a hidden one before a showing one', () => {
  page(`
    <textarea id="reply"></textarea>
    <div data-hidden data-pn-annotation-toolbar-row="true"></div>
    <div class="toolbar"><div data-pn-annotation-toolbar-row="true"><button id="comment">Comment</button></div></div>
    <button id="b">x</button>
  `);
  // page() leaves a data-hidden element with no client rects; it is the first toolbar in the document.
  $('[data-hidden]').getClientRects = () => [] as unknown as DOMRectList;
  $<HTMLTextAreaElement>('#reply').focus();
  $<HTMLButtonElement>('#b').focus();
  commandV();
  expect(document.activeElement).toBe($('#b'));
  // The showing toolbar closed: only the hidden one is left, and the paste follows the reply box.
  $('.toolbar').remove();
  commandV();
  expect(document.activeElement).toBe($('#reply'));
});

test.skipIf(!hasDom)('a field clipped out of its pane is not on screen, even when the hit lands on the pane that holds it', () => {
  page(`<div id="pane" style="overflow: auto; height: 300px"><div id="list"><textarea id="note"></textarea></div></div><button id="b">x</button>`);
  const note = $<HTMLTextAreaElement>('#note');
  const pane = $<HTMLElement>('#pane');
  const rect = (top: number, height: number, left = 0, width = 400) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
  const saved = document.elementFromPoint;
  try {
    note.focus();
    $<HTMLButtonElement>('#b').focus();
    // The pane shows y 0 to 300; the note sits at y 500, scrolled below its edge, still inside the window.
    pane.getBoundingClientRect = () => rect(0, 300);
    note.getBoundingClientRect = () => rect(500, 40, 10, 200);
    // What a browser hits there is the page or an element holding the pane, never the note.
    document.elementFromPoint = () => $('#list');
    commandV();
    expect(document.activeElement).toBe($('#b'));
    // Even with no hit test at all, the pane's own clip refuses it.
    document.elementFromPoint = (() => null) as typeof document.elementFromPoint;
    commandV();
    expect(document.activeElement).toBe($('#b'));
    // Scrolled into the pane: the note is on screen and takes the paste.
    note.getBoundingClientRect = () => rect(100, 40, 10, 200);
    document.elementFromPoint = () => note;
    commandV();
    expect(document.activeElement).toBe(note);
  } finally {
    document.elementFromPoint = saved;
  }
});

test.skipIf(!hasDom)("a document's selection toolbar showing (the words drawn as a pending highlight): not redirected", () => {
  page(`<textarea id="reply"></textarea><div class="toolbar"><div data-pn-annotation-toolbar-row="true"><button id="comment">Comment</button></div></div><button id="b">x</button>`);
  $<HTMLTextAreaElement>('#reply').focus();
  $<HTMLButtonElement>('#b').focus();
  commandV();
  expect(document.activeElement).toBe($('#b'));
  // The toolbar closed: the paste follows the reply box again.
  $('.toolbar').remove();
  commandV();
  expect(document.activeElement).toBe($('#reply'));
});

test.skipIf(!hasDom)("words selected in a thread message (its toolbar showing, approval \"inbox-message-comments\"): the paste still follows the field", () => {
  page(
    `<textarea id="reply"></textarea><div class="ib-body"><p>The backoff is <mark class="annotation-highlight" data-highlight-id="p1">2, 4 and 8</mark> seconds.</p></div>` +
      `<div class="toolbar"><div data-pn-annotation-toolbar-row="true"><button id="comment">Comment</button></div></div><button id="b">x</button>`,
  );
  $<HTMLTextAreaElement>('#reply').focus();
  $<HTMLButtonElement>('#b').focus();
  // The words are left for the field: a press on the field reaches ui's toolbar, which closes it and its pending mark.
  let pressed = 0;
  document.addEventListener('mousedown', (event) => {
    if (event.target === $('#reply')) pressed += 1;
  }, true);
  commandV();
  expect(document.activeElement).toBe($('#reply'));
  expect(pressed).toBe(1);
  // A saved comment's mark is not a pending selection: a file's toolbar showing still holds the paste.
  $('mark').classList.add('comment');
  $<HTMLButtonElement>('#b').focus();
  commandV();
  expect(document.activeElement).toBe($('#b'));
});

test.skipIf(!hasDom)('a field out of view, out of the window or out of its pane, is left alone', () => {
  page(`<div id="pane"><textarea id="note"></textarea></div><div id="beside"></div><button id="b">x</button>`);
  const note = $<HTMLTextAreaElement>('#note');
  const saved = document.elementFromPoint;
  try {
    note.focus();
    $<HTMLButtonElement>('#b').focus();
    // Scrolled above the window.
    note.getBoundingClientRect = () => ({ left: 10, top: -400, width: 200, height: 40, right: 210, bottom: -360, x: 10, y: -400, toJSON() {} }) as DOMRect;
    commandV();
    expect(document.activeElement).toBe($('#b'));
    // Inside the window but scrolled out of its pane: what is hit there is the pane beside it.
    note.getBoundingClientRect = () => ({ left: 10, top: 100, width: 200, height: 40, right: 210, bottom: 140, x: 10, y: 100, toJSON() {} }) as DOMRect;
    document.elementFromPoint = () => $('#beside');
    commandV();
    expect(document.activeElement).toBe($('#b'));
    // Scrolled back into view.
    document.elementFromPoint = () => note;
    commandV();
    expect(document.activeElement).toBe(note);
  } finally {
    document.elementFromPoint = saved;
  }
});

test.skipIf(!hasDom)('something drawn over the field (a sheet, a popover): left alone', () => {
  page(`<textarea id="reply"></textarea><div id="sheet"><button id="b">x</button></div>`);
  const reply = $<HTMLTextAreaElement>('#reply');
  const saved = document.elementFromPoint;
  try {
    reply.focus();
    $<HTMLButtonElement>('#b').focus();
    document.elementFromPoint = () => $('#sheet');
    commandV();
    expect(document.activeElement).toBe($('#b'));
    // The field itself on top: the paste follows it.
    document.elementFromPoint = () => reply;
    commandV();
    expect(document.activeElement).toBe(reply);
  } finally {
    document.elementFromPoint = saved;
  }
});

test.skipIf(!hasDom)('several fields: a ⌘V on a choice, a button or the page goes back to the field last written in, caret kept', () => {
  page(`
    <textarea id="reply"></textarea>
    <input id="other" type="text">
    <div id="rich" contenteditable="true"></div>
    <label><input id="choice" type="radio" name="q"> Retry</label>
    <button id="chip">Keep open</button>
    <p id="text" tabindex="-1">The agent's message</p>
  `);
  const reply = $<HTMLTextAreaElement>('#reply');
  const other = $<HTMLInputElement>('#other');
  const rich = $<HTMLElement>('#rich');

  // The reply box: words in it, the caret in the middle, then a pick on a question.
  reply.focus();
  reply.value = 'one three';
  reply.setSelectionRange(4, 4);
  $<HTMLInputElement>('#choice').focus();
  const v = commandV();
  expect(document.activeElement).toBe(reply);
  expect([reply.selectionStart, reply.selectionEnd]).toEqual([4, 4]);
  // Never cancelled: the browser's own paste runs, into the field.
  expect(v.defaultPrevented).toBe(false);

  // A text input (a question's Other), then a button.
  other.focus();
  other.value = 'Other';
  other.setSelectionRange(5, 5);
  $<HTMLButtonElement>('#chip').focus();
  commandV();
  expect(document.activeElement).toBe(other);
  expect(other.selectionStart).toBe(5);

  // A contenteditable, then the message text (focus on the page itself).
  rich.focus();
  $<HTMLElement>('#text').focus();
  commandV();
  expect(document.activeElement).toBe(rich);

  // Focus on the page itself.
  (document.activeElement as HTMLElement).blur();
  expect(document.activeElement).toBe(document.body);
  commandV();
  expect(document.activeElement).toBe(rich);
});

test.skipIf(!hasDom)('a paste already aimed at a field stays there', () => {
  page(`<textarea id="reply"></textarea><input id="search" type="search">`);
  $<HTMLTextAreaElement>('#reply').focus();
  $<HTMLInputElement>('#search').focus();
  commandV();
  expect(document.activeElement).toBe($('#search'));
});

test.skipIf(!hasDom)('left alone: no field used yet, a frame, a field gone, disabled, read-only or hidden', () => {
  page(`<button id="b">x</button><iframe id="f"></iframe>`);
  $<HTMLButtonElement>('#b').focus();
  commandV();
  expect(document.activeElement).toBe($('#b'));

  for (const [html, change] of [
    ['<textarea id="t"></textarea>', (t: HTMLTextAreaElement) => t.remove()],
    ['<textarea id="t"></textarea>', (t: HTMLTextAreaElement) => (t.disabled = true)],
    ['<textarea id="t"></textarea>', (t: HTMLTextAreaElement) => (t.readOnly = true)],
    ['<div id="w"><textarea id="t"></textarea></div>', (t: HTMLTextAreaElement) => t.parentElement!.setAttribute('inert', '')],
    ['<textarea id="t"></textarea>', (t: HTMLTextAreaElement) => (t.getClientRects = () => [] as unknown as DOMRectList)],
  ] as const) {
    page(`${html}<button id="b">x</button>`);
    const t = $<HTMLTextAreaElement>('#t');
    t.focus();
    $<HTMLButtonElement>('#b').focus();
    change(t);
    commandV();
    expect(document.activeElement).toBe($('#b'));
  }

  // Focus in a frame (an attached HTML page): the page in it owns the keys.
  page(`<textarea id="t"></textarea><iframe id="f"></iframe>`);
  $<HTMLTextAreaElement>('#t').focus();
  $<HTMLIFrameElement>('#f').focus();
  if (document.activeElement === $('#f')) {
    commandV();
    expect(document.activeElement).toBe($('#f'));
  }
});

test.skipIf(!hasDom)('a modal dialog: a field behind it is no target; a field inside it is (compose)', () => {
  page(`
    <textarea id="reply"></textarea>
    <div id="dialog" aria-modal="true" role="dialog"><textarea id="message"></textarea><button id="to">To</button></div>
  `);
  // The reply box was last, then compose opened over it.
  $<HTMLTextAreaElement>('#reply').focus();
  $<HTMLButtonElement>('#to').focus();
  commandV();
  expect(document.activeElement).toBe($('#to'));

  // In compose: the message, then To.
  $<HTMLTextAreaElement>('#message').focus();
  $<HTMLButtonElement>('#to').focus();
  commandV();
  expect(document.activeElement).toBe($('#message'));
});

test.skipIf(!hasDom)('other chords are untouched', () => {
  page(`<textarea id="reply"></textarea><button id="b">x</button>`);
  $<HTMLTextAreaElement>('#reply').focus();
  $<HTMLButtonElement>('#b').focus();
  commandV({ key: 'c', code: 'KeyC' });
  expect(document.activeElement).toBe($('#b'));
  commandV({ metaKey: false, ctrlKey: true });
  expect(document.activeElement).toBe($('#b'));
});
