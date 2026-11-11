import { useEffect, useState } from 'react';

/** How long after the initial load an announcement may still open. */
export const FIRST_RUN_ANNOUNCEMENT_WINDOW_MS = 4000;

/**
 * How long after the initial load a window blur is still taken for the app's own startup (a
 * viewer focusing its iframe) rather than the reader.
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

function isWorkingIn(element: Element | null): boolean {
  return isEditable(element) || element instanceof HTMLIFrameElement;
}

interface Options {
  readonly pending: boolean;
  readonly eligible: boolean;
  readonly armed: boolean;
  readonly windowMs?: number;
  readonly blurGraceMs?: number;
}

/**
 * Lets a non-blocking announcement open only before the reader has started working: before their
 * first pointer press, key press or focus into an editable field.
 */
export function useFirstRunAnnouncementWindow({
  pending,
  eligible,
  armed,
  windowMs = FIRST_RUN_ANNOUNCEMENT_WINDOW_MS,
  blurGraceMs = FIRST_RUN_ANNOUNCEMENT_BLUR_GRACE_MS,
}: Options): boolean {
  const [phase, setPhase] = useState<Phase>('waiting');

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

  // Work inside an iframe (raw-HTML or live-app annotate) never reaches the listeners above, but
  // moving into it blurs this window.
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

  useEffect(() => {
    if (phase !== 'waiting' || !pending || !armed) return;
    const timer = setTimeout(() => {
      setPhase((current) => (current === 'waiting' ? 'missed' : current));
    }, windowMs);
    return () => clearTimeout(timer);
  }, [phase, pending, armed, windowMs]);

  // Never over a field or a framed page the reader is in (a comment composer, a search box, a
  // raw-HTML page), even an autofocused one.
  useEffect(() => {
    if (phase !== 'waiting' || !pending || !eligible) return;
    setPhase(isWorkingIn(document.activeElement) ? 'missed' : 'shown');
  }, [phase, pending, eligible]);

  return pending && phase === 'shown';
}
