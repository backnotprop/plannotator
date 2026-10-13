import { useEffect, useState } from 'react';

/** How long after the initial load an announcement may still open. */
export const FIRST_RUN_ANNOUNCEMENT_WINDOW_MS = 4000;

/**
 * How long after the initial load a window blur is still taken for the app's
 * own startup (a viewer focusing its iframe) rather than the reader.
 */
export const FIRST_RUN_ANNOUNCEMENT_BLUR_GRACE_MS = 1000;

type Phase = 'waiting' | 'shown' | 'missed';

function isEditable(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (element as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
}

/**
 * The reader is in something the parent cannot see into: a text field, or an
 * iframe (the raw-HTML and live-app annotate surfaces), where their typing
 * never reaches this document's listeners.
 */
function isWorkingIn(element: Element | null): boolean {
  return isEditable(element) || element instanceof HTMLIFrameElement;
}

interface Options {
  /** The announcement has not been seen (latched at mount). */
  readonly pending: boolean;
  /** Every other condition for opening holds right now. */
  readonly eligible: boolean;
  /** The initial payload has loaded; the window's clock starts here. */
  readonly armed: boolean;
  readonly windowMs?: number;
  readonly blurGraceMs?: number;
}

/**
 * Lets a non-blocking announcement open only before the reader has started
 * working: before their first pointer press, key press or focus into an
 * editable field, and within `windowMs` of the initial load. An announcement
 * whose conditions arrive later (a slow capabilities answer, say) would take
 * focus mid-sentence, and the Space or Enter that follows would dismiss it
 * unread and spend its cookie. Instead it misses this load and waits for the
 * next one; nothing is written. Once open, it stays until dismissed.
 */
export function useFirstRunAnnouncementWindow({
  pending,
  eligible,
  armed,
  windowMs = FIRST_RUN_ANNOUNCEMENT_WINDOW_MS,
  blurGraceMs = FIRST_RUN_ANNOUNCEMENT_BLUR_GRACE_MS,
}: Options): boolean {
  const [phase, setPhase] = useState<Phase>('waiting');

  // The reader's first move closes the window.
  useEffect(() => {
    if (phase !== 'waiting' || !pending) return;
    const miss = () => setPhase((current) => (current === 'waiting' ? 'missed' : current));
    const onFocusIn = (event: FocusEvent) => {
      if (isEditable(event.target as Element | null)) miss();
    };
    document.addEventListener('pointerdown', miss, true);
    document.addEventListener('keydown', miss, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('pointerdown', miss, true);
      document.removeEventListener('keydown', miss, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [phase, pending]);

  // Work inside an iframe (raw-HTML or live-app annotate) never reaches the
  // listeners above, but moving into it blurs this window. Counted only after
  // the app's own startup, which may focus a viewer iframe by itself.
  useEffect(() => {
    if (phase !== 'waiting' || !pending || !armed) return;
    const miss = () => setPhase((current) => (current === 'waiting' ? 'missed' : current));
    let listening = false;
    const grace = setTimeout(() => {
      listening = true;
      window.addEventListener('blur', miss);
    }, blurGraceMs);
    return () => {
      clearTimeout(grace);
      if (listening) window.removeEventListener('blur', miss);
    };
  }, [phase, pending, armed, blurGraceMs]);

  // So does time, counted from the end of the initial load.
  useEffect(() => {
    if (phase !== 'waiting' || !pending || !armed) return;
    const timer = setTimeout(() => {
      setPhase((current) => (current === 'waiting' ? 'missed' : current));
    }, windowMs);
    return () => clearTimeout(timer);
  }, [phase, pending, armed, windowMs]);

  // Open while the window is still open. Never over a field or a framed page
  // the reader is in (a comment composer, a search box, a raw-HTML page), even
  // an autofocused one.
  useEffect(() => {
    if (phase !== 'waiting' || !pending || !eligible) return;
    setPhase(isWorkingIn(document.activeElement) ? 'missed' : 'shown');
  }, [phase, pending, eligible]);

  return pending && phase === 'shown';
}
