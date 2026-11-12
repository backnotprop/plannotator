/** Works around a Chrome 155 to 156 bug on macOS, and runs only there (`chromiumPasteBugAffected`). */

/** Input types the page can insert into with a caret (email and number have no selection API). */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password']);

const NATIVE_PASTE = '[data-native-paste], .xterm, .cm-editor, .monaco-editor';

export type PlainTextField = HTMLTextAreaElement | HTMLInputElement;

export interface PasteInsertion {
  field: PlainTextField;
  text: string;
  start: number;
  end: number;
}

type PasteLike = Pick<ClipboardEvent, 'defaultPrevented' | 'clipboardData' | 'target'> & {
  composedPath?: () => EventTarget[];
};

function plainTextField(target: EventTarget | null | undefined): PlainTextField | null {
  if (!target || typeof (target as Node).nodeType !== 'number') return null;
  const el = target as Element;
  const view = el.ownerDocument?.defaultView;
  if (!view) return null;
  if (el instanceof view.HTMLTextAreaElement) return el;
  if (el instanceof view.HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)) return el;
  return null;
}

function carriesFiles(data: DataTransfer): boolean {
  if ((data.files?.length ?? 0) > 0) return true;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file') return true;
  }
  return false;
}

function focused(field: PlainTextField): boolean {
  const root = field.getRootNode() as Document | ShadowRoot;
  return 'activeElement' in root && root.activeElement === field;
}

function truncate(text: string, room: number): string {
  if (text.length <= room) return text;
  let cut = room;
  const last = text.charCodeAt(cut - 1);
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/** What the page should insert for this paste, or null to leave it to the browser. */
export function plainTextPasteInsertion(event: PasteLike, composing = false): PasteInsertion | null {
  if (event.defaultPrevented || composing) return null;
  const data = event.clipboardData;
  if (!data) return null;
  const path = event.composedPath?.() ?? [];
  const field = plainTextField(path[0] ?? event.target);
  if (!field) return null;
  if (field.readOnly || field.disabled) return null;
  if (field.closest(NATIVE_PASTE)) return null;
  if (!focused(field)) return null;
  if (carriesFiles(data)) return null;
  let text = data.getData('text/plain');
  if (!text) return null;
  // What Chrome does with line breaks: a textarea keeps each as \n, a one-line input turns each into a space.
  text = text.replace(/\r\n?/g, '\n');
  if (field.tagName !== 'TEXTAREA') text = text.replace(/\n/g, ' ');
  if (!text) return null;
  const start = field.selectionStart;
  const end = field.selectionEnd;
  if (start === null || end === null) return null;
  if (field.maxLength >= 0) {
    const room = field.maxLength - (field.value.length - (end - start));
    if (room <= 0) return null; // the browser inserts nothing either
    text = truncate(text, room);
    if (!text) return null;
  }
  return { field, text, start, end };
}

/** Insert as typing would: an undo step and an `input` event. */
export function insertPastedText({ field, text, start, end }: PasteInsertion): void {
  const doc = field.ownerDocument;
  let inserted = false;
  try {
    inserted = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, text) === true;
  } catch {
    inserted = false;
  }
  if (inserted) return;
  field.setRangeText(text, start, end, 'end');
  const caret = start + text.length;
  field.setSelectionRange(caret, caret); // some engines put the caret elsewhere after setRangeText
  const view = doc.defaultView;
  const event =
    view && typeof view.InputEvent === 'function'
      ? new view.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text })
      : new Event('input', { bubbles: true });
  field.dispatchEvent(event);
}

/** What the gate reads off `navigator` (User-Agent Client Hints are Chromium-only). */
export interface PasteEngineNavigator {
  userAgent?: string;
  platform?: string;
  userAgentData?: { brands?: ReadonlyArray<{ brand: string; version: string }>; platform?: string } | null;
}

// Chromium 155 added the check; 157 ships the fix.
const AFFECTED_CHROMIUM = new Set([155, 156]);

/**
 * Only Chromium 155 and 156 on macOS have the bug, so only they get the workaround: it turns
 * itself off when 157 arrives, and Safari.
 */
export function chromiumPasteBugAffected(nav: PasteEngineNavigator | undefined | null): boolean {
  if (!nav) return false;
  const ua = nav.userAgent ?? '';
  const data = nav.userAgentData ?? null;
  let major = Number.NaN;
  const brand = data?.brands?.find((b) => b.brand === 'Chromium');
  if (brand) major = Number.parseInt(brand.version, 10);
  if (Number.isNaN(major)) {
    const match = /Chrome\/(\d+)/.exec(ua);
    if (match) major = Number.parseInt(match[1]!, 10);
  }
  if (!AFFECTED_CHROMIUM.has(major)) return false;
  if (data?.platform) return /^mac/i.test(data.platform);
  return /^mac/i.test(nav.platform ?? '') || /Macintosh|Mac OS X/.test(ua);
}

/**
 * Tests (the e2e simulation, in a Chromium that is not 155 or 156) set this to `true` on the
 * window to turn the workaround on whatever the engine.
 */
export const FORCE_PLAIN_TEXT_PASTE_FLAG = '__plannotatorForcePlainTextPaste';

export interface PlainTextPasteOptions {
  /** Whether the workaround runs. */
  enabled?: boolean;
  /** Act on script-dispatched (untrusted) paste events too; for tests. */
  allowUntrusted?: boolean;
}

export function installPlainTextPaste(win: Window = window, options: PlainTextPasteOptions = {}): () => void {
  const doc = win.document;
  const engine = chromiumPasteBugAffected(win.navigator as unknown as PasteEngineNavigator);
  const forced = () => (win as unknown as Record<string, unknown>)[FORCE_PLAIN_TEXT_PASTE_FLAG] === true;
  const enabled = () => options.enabled ?? (engine || forced());
  let composing = false;
  const onCompositionStart = () => {
    composing = true;
  };
  // Also on focus moving and the window losing focus: a compositionend that never arrives must not
  // leave the workaround off until reload.
  const onCompositionEnd = () => {
    composing = false;
  };
  const onPaste = (event: ClipboardEvent) => {
    if (!enabled()) return;
    if (!event.isTrusted && !options.allowUntrusted) return; // a script's paste event inserts nothing
    const insertion = plainTextPasteInsertion(event, composing);
    if (!insertion) return;
    event.preventDefault();
    insertPastedText(insertion);
  };
  doc.addEventListener('compositionstart', onCompositionStart, true);
  doc.addEventListener('compositionend', onCompositionEnd, true);
  doc.addEventListener('focusin', onCompositionEnd, true);
  win.addEventListener('blur', onCompositionEnd);
  win.addEventListener('paste', onPaste);
  return () => {
    doc.removeEventListener('compositionstart', onCompositionStart, true);
    doc.removeEventListener('compositionend', onCompositionEnd, true);
    doc.removeEventListener('focusin', onCompositionEnd, true);
    win.removeEventListener('blur', onCompositionEnd);
    win.removeEventListener('paste', onPaste);
  };
}
