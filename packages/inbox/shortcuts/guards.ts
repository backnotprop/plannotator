/**
 * When an Inbox key stands down: the rules every Inbox scope shares, in one
 * place. Each scope's `when` combines the ones it needs (a bare letter never
 * fires while typing; a step never fires under a dialog; Escape is the
 * focused component's first). The registry already refuses a binding whose
 * modifiers differ from the key's (`E` never matches ⌘E or ⌥E).
 */
import { isTouchPhone } from '../phone';
import { selectionToolbarShowing } from '../selectionToolbar';
import { shortcutPrefs } from './prefs';

/**
 * Whether single keys (letters, J / K and Shift+J / Shift+K, `[` `]`, `/`, G) act at all: Single-key shortcuts on,
 * and not a real touch phone (`isTouchPhone`: the phone layout with a coarse pointer and no hover). A desktop window
 * narrower than 768 px draws the phone layout (no keycaps, no map button) but keeps every key, as on main; `?`
 * works on a touch phone too, for a hardware keyboard (design §5.4; `bareKeyAllowed`'s `onTouchPhone`).
 */
export function singleKeysLive(prefs: { singleKeys: boolean } = shortcutPrefs(), { onTouchPhone = false } = {}): boolean {
  return prefs.singleKeys && (onTouchPhone || !isTouchPhone());
}

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

/**
 * A binding that is one plain key (or a sequence of them): a letter, a digit
 * or a punctuation key, no ⌘ / Ctrl / Alt. These are the keys Single-key
 * shortcuts turns off (WCAG 2.1.4): Escape, Enter, Tab, the arrows, Home / End
 * and every chord keep working.
 */
export function isBareBinding(binding: string): boolean {
  const tokens = binding.trim().split(/[+\s]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.includes('Mod') || tokens.includes('Alt')) return false;
  return tokens.filter((token) => token !== 'Shift').every((token) => token.length === 1);
}

/**
 * Whether a single key may act now, for every Inbox scope: never while typing
 * (a field, a contenteditable), while an input method composes, on a held
 * key's repeat, with ⌘ / Ctrl / Alt, from inside a dialog, menu, listbox or a
 * file's frame, under a modal, while words selected in a message show their
 * toolbar (a printable key starts a comment there), after something else used
 * the key, when Single-key shortcuts is off, or on a touch phone (unless
 * `onTouchPhone`: `?`). A scope adds its own rules
 * (the tour's replay, a guided review) on top.
 */
export function bareKeyAllowed(event: KeyboardEvent, prefs: { singleKeys: boolean } = shortcutPrefs(), { onTouchPhone = false } = {}): boolean {
  if (!singleKeysLive(prefs, { onTouchPhone })) return false;
  if (event.defaultPrevented || isRepeatKey(event) || isComposingKey(event) || hasCommandModifier(event)) return false;
  const target = keyTarget(event);
  if (target) {
    if (isEditableTarget(target) || inOverlay(target)) return false;
    if (target.closest('[role="menu"], [role="listbox"], iframe')) return false;
  }
  if (modalOpen()) return false;
  if (typeof document !== 'undefined' && selectionToolbarShowing(document)) return false;
  return true;
}
