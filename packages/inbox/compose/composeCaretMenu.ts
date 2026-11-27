import { useMemo, type RefObject } from 'react';
import type { CaretMenuOptions } from '../components/ComposerField';

/** A phone's picker shows at most 4½ rows of 44 px (the reply box's rule, inbox.css). */
const PHONE_SKILL_LIST_HEIGHT = 198;

/**
 * The skill picker's room. A desktop: the whole window (the visual viewport), so the picker floats over everything in
 * the dialog, the footer included, and past the dialog's bottom edge when it needs to; it is in the dialog's top layer
 * and painted after the footer, so nothing covers it. A phone (a full-screen sheet): below its top bar, above its
 * footer and the keyboard.
 */
export function useComposeCaretMenu(phone: boolean, dialogRef: RefObject<HTMLDialogElement | null>): CaretMenuOptions {
  return useMemo<CaretMenuOptions>(
    () => ({
      prefer: phone ? 'above' : 'below',
      maxListHeight: phone ? PHONE_SKILL_LIST_HEIGHT : undefined,
      bounds: () => {
        const viewport = window.visualViewport;
        const seen = viewport ? { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height } : { top: 0, bottom: window.innerHeight };
        if (!phone) return seen;
        const dialog = dialogRef.current;
        if (!dialog) return null;
        const box = dialog.getBoundingClientRect();
        const bar = dialog.querySelector('.ib-cp-bar')?.getBoundingClientRect();
        const foot = dialog.querySelector('.ib-cp-foot')?.getBoundingClientRect();
        return { top: Math.max(seen.top, bar ? bar.bottom : box.top), bottom: Math.min(foot ? foot.top : box.bottom, seen.bottom) };
      },
    }),
    [phone, dialogRef],
  );
}
