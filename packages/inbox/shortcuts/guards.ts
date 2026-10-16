/**
 * When an Inbox key stands down: the rules every Inbox scope shares, in one
 * place. Each scope's `when` combines the ones it needs (a bare letter never
 * fires while typing; a step never fires under a dialog; Escape is the
 * focused component's first). The registry already refuses a binding whose
 * modifiers differ from the key's (`E` never matches ⌘E or ⌥E).
 */

/**
 * The element the key came from. `composedPath()[0]` reaches into shadow
 * roots (Pierre's code view, where `target` is the shadow host).
 */
export function keyTarget(event: Event): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const first = path[0] ?? event.target;
  return first instanceof Element ? first : event.target instanceof Element ? event.target : null;
}

/** Where focus is a place to type: a bare key, `[` `]` and the arrows are text there. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  if (el.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes((el as HTMLInputElement).type);
  return false;
}

/** The key belongs to an input method mid-composition (a Japanese or Chinese IME): never a shortcut. */
export function isComposingKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** A bare key held down repeats: a step or a toggle fires once per press. */
export function isRepeatKey(event: KeyboardEvent): boolean {
  return event.repeat;
}

/** ⌘, Ctrl or Alt held: ⌘[ ⌘] are the browser's Back and Forward, ⌥ letters type characters. */
export function hasCommandModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

/**
 * A modal over the window keeps its keys: the Inbox's dialogs (update, sound,
 * agent note, search, compose: `<dialog open>`) and the image annotator's
 * stage (Mark up).
 */
export function modalOpen(doc: Document | null = typeof document === 'undefined' ? null : document): boolean {
  if (!doc) return false;
  return doc.querySelector('dialog[open], [data-pn-image-annotator-stage]') !== null;
}

/** The key came from inside a dialog or a popover layer (a composer, the image annotator): it is theirs. */
export function inOverlay(target: Element | null): boolean {
  return !!target?.closest('[role="dialog"], [role="alertdialog"], [data-popover-layer], [data-pn-image-annotator-stage]');
}
