import { isModKeyHeld } from '@plannotator/ui/utils/platform';

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number']);

const COVERS = '.ib-view.ib-full, .ib-viewer';
const MODALS = 'dialog[open], [aria-modal="true"]';

const REMEMBERED = 8;

type TextField = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export function isTextField(target: EventTarget | null | undefined): target is TextField {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  return target.isContentEditable;
}

type KeyFields = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>;

export function isPasteKey(event: KeyFields, mod: (e: { metaKey: boolean; ctrlKey: boolean }) => boolean = isModKeyHeld): boolean {
  if (event.isComposing || event.altKey || !mod(event)) return false;
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase() === 'v';
  return event.code === 'KeyV';
}

function isModal(el: Element): boolean {
  if (!(el instanceof HTMLDialogElement)) return true;
  try {
    return el.matches(':modal');
  } catch {
    return true;
  }
}

type Sight = 'top' | 'covered' | 'offscreen' | 'unknown';

function sight(field: TextField): Sight {
  const doc = field.ownerDocument;
  const view = doc.defaultView;
  if (!view) return 'unknown';
  const rect = field.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + Math.min(rect.height / 2, 12);
  if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return 'offscreen';
  if (clippedOut(field, x, y)) return 'offscreen';
  if (typeof doc.elementFromPoint !== 'function') return 'unknown';
  const hit = doc.elementFromPoint(x, y);
  if (!hit) return 'unknown';
  return hit === field || field.contains(hit) ? 'top' : 'covered';
}

function clippedOut(field: TextField, x: number, y: number): boolean {
  const view = field.ownerDocument.defaultView;
  if (!view) return false;
  for (let el = field.parentElement; el && el !== field.ownerDocument.documentElement; el = el.parentElement) {
    const style = view.getComputedStyle(el);
    const clipsX = style.overflowX !== 'visible';
    const clipsY = style.overflowY !== 'visible';
    if (!clipsX && !clipsY) continue;
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    if ((clipsX && (x < box.left || x >= box.right)) || (clipsY && (y < box.top || y >= box.bottom))) return true;
  }
  return false;
}

function usable(field: TextField): boolean {
  if (!field.isConnected) return false;
  if ((field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) && (field.disabled || field.readOnly)) return false;
  if (field.closest('[inert], [aria-hidden="true"]')) return false;
  if (field.getClientRects().length === 0) return false;
  const doc = field.ownerDocument;
  for (const modal of doc.querySelectorAll(MODALS)) {
    if (isModal(modal) && !modal.contains(field)) return false;
  }
  const seen = sight(field);
  if (seen === 'covered' || seen === 'offscreen') return false;
  for (const cover of doc.querySelectorAll(COVERS)) {
    if (!cover.contains(field) && seen !== 'top') return false;
  }
  return true;
}

function pageSelection(doc: Document): boolean {
  if (!messageSelectionPending(doc)) {
    for (const toolbar of doc.querySelectorAll('[data-pn-annotation-toolbar-row]')) {
      if (toolbar.getClientRects().length > 0) return true;
    }
  }
  return fileViewSelection(doc);
}

function messageSelectionPending(doc: Document): boolean {
  return doc.querySelector('.ib-body mark.annotation-highlight:not(.comment):not(.deletion)') !== null;
}

const ANNOTATABLE_VIEW = '.ib-view, .ib-viewer';

function fileViewSelection(doc: Document): boolean {
  const selection = doc.getSelection?.();
  if (!selection || selection.rangeCount === 0) return false;
  if (!selection.toString().trim()) return false;
  const node = selection.anchorNode;
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  if (!el) return false;
  if (isTextField(el) || el.closest('textarea, input, [contenteditable="true"], [contenteditable=""]')) return false;
  return el.closest(ANNOTATABLE_VIEW) !== null;
}

export function installPasteFollowsField(win: Window = window, mod?: (e: { metaKey: boolean; ctrlKey: boolean }) => boolean): () => void {
  const doc = win.document;
  let recent: TextField[] = [];
  const carets = new WeakMap<TextField, number>();

  const remember = (event: FocusEvent) => {
    const target = event.target;
    if (!isTextField(target)) return;
    recent = [target, ...recent.filter((field) => field !== target && field.isConnected)].slice(0, REMEMBERED);
  };
  const leave = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) || !isTextField(target)) return;
    try {
      if (target.selectionEnd !== null) carets.set(target, target.selectionEnd);
    } catch {
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !isPasteKey(event, mod)) return;
    const active = doc.activeElement;
    if (isTextField(active) || active instanceof HTMLIFrameElement) return;
    if (pageSelection(doc)) return;
    const field = recent.find(usable);
    if (!field) return;
    const caret = carets.get(field);
    if (messageSelectionPending(doc)) field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 }));
    field.focus({ preventScroll: true });
    if (doc.activeElement !== field) return;
    if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
      try {
        const length = field.value.length;
        const at = Math.min(caret ?? field.selectionEnd ?? length, length);
        field.setSelectionRange(at, at, 'none');
      } catch {
      }
    }
  };

  doc.addEventListener('focusin', remember, true);
  doc.addEventListener('focusout', leave, true);
  win.addEventListener('keydown', onKey, true);
  return () => {
    doc.removeEventListener('focusin', remember, true);
    doc.removeEventListener('focusout', leave, true);
    win.removeEventListener('keydown', onKey, true);
  };
}
