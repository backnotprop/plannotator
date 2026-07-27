import { useEffect, useRef } from 'react';

const VIM_DOCUMENT_FOCUS_REQUEST = 'plannotator:vim-document-focus-request';

const EDITABLE_FOCUS_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="combobox"]',
].join(',');

const BLOCKING_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  // Some legacy Plannotator modals predate explicit dialog semantics. Keep
  // Vim from focusing the obscured document underneath those full-screen
  // overlays while they are brought onto the shared dialog primitive.
  '.fixed.inset-0',
].join(',');

/** Inputs for restoring keyboard ownership to a Vim-enabled document. */
export interface UseVimDocumentFocusOptions {
  readonly enabled: boolean;
  readonly blocked: boolean;
  /** Focus the owning document surface and report whether focus moved to it. */
  readonly focusDocument: () => boolean;
}

function pageFocusIsNeutral(): boolean {
  return document.activeElement === document.body || document.activeElement === null;
}

function hasBlockingOverlay(): boolean {
  return document.querySelector(BLOCKING_OVERLAY_SELECTOR) !== null;
}

function targetOwnsTextInput(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE_FOCUS_SELECTOR) !== null;
}

/** Ask the active Vim document to reclaim focus after an owned UI closes. */
export function requestVimDocumentFocus(): void {
  document.dispatchEvent(new Event(VIM_DOCUMENT_FOCUS_REQUEST, { cancelable: true }));
}

/**
 * Give an enabled Vim document initial keyboard ownership and let Escape from
 * neutral app chrome return to it.
 *
 * Editable controls and overlays retain first ownership of Escape. The hook
 * only prevents the event after focus actually moves back to the document.
 */
export function useVimDocumentFocus({
  enabled,
  blocked,
  focusDocument,
}: UseVimDocumentFocusOptions): void {
  const autoFocusAttemptedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      autoFocusAttemptedRef.current = false;
      return;
    }
    if (autoFocusAttemptedRef.current) return;
    autoFocusAttemptedRef.current = true;
    if (blocked || !pageFocusIsNeutral() || hasBlockingOverlay()) return;
    focusDocument();
  }, [blocked, enabled, focusDocument]);

  useEffect(() => {
    if (!enabled) return;

    const handleFocusRequest = (event: Event) => {
      if (
        !event.defaultPrevented
        && !blocked
        && !hasBlockingOverlay()
        && focusDocument()
      ) {
        // One visible document owns each request when a host renders multiple
        // Viewer instances.
        event.preventDefault();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape'
        || event.defaultPrevented
        || event.isComposing
        || event.ctrlKey
        || event.metaKey
        || event.altKey
        || event.shiftKey
        || blocked
        || targetOwnsTextInput(event.target)
        || hasBlockingOverlay()
      ) {
        return;
      }

      if (focusDocument()) {
        event.preventDefault();
      }
    };

    document.addEventListener(VIM_DOCUMENT_FOCUS_REQUEST, handleFocusRequest);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener(VIM_DOCUMENT_FOCUS_REQUEST, handleFocusRequest);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [blocked, enabled, focusDocument]);
}
