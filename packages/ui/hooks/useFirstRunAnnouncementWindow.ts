import { useEffect, useState } from 'react';

export const FIRST_RUN_ANNOUNCEMENT_WINDOW_MS = 4000;

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

  useEffect(() => {
    if (phase !== 'waiting' || !pending || !eligible) return;
    setPhase(isWorkingIn(document.activeElement) ? 'missed' : 'shown');
  }, [phase, pending, eligible]);

  return pending && phase === 'shown';
}
