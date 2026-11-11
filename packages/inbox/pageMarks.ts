/** Page marks replace `:has()` rules anchored on `html`, `body` or `.pn-inbox`: Chromium re-checks those on every DOM change (about 40 ms per change on a long thread). */
import { holdPageMark, holdPageMarkAbove } from '@plannotator/ui/utils/pageMarks';

export function markInboxPage(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  const page = holdPageMark(el.ownerDocument.documentElement, 'data-pn-inbox');
  const body = holdPageMark(el.ownerDocument.body, 'data-pn-inbox');
  return () => {
    page();
    body();
  };
}

const aboveInbox = (name: string) => (el: HTMLElement | null) => (el ? holdPageMarkAbove(el, '.pn-inbox', name) : undefined);

export const markDecisionPill = aboveInbox('data-ib-dm-pill');
export const markImageComposer = aboveInbox('data-ib-imgcompose');
export const markFullScreenComposer = aboveInbox('data-ib-fcomp');
export const markRecipientList = aboveInbox('data-ib-rpick');

const onBody = (name: string) => (el: HTMLElement | null) => (el ? holdPageMark(el.ownerDocument.body, name) : undefined);

export const markShapeDock = onBody('data-ib-shape-dock');
export const markShapePill = onBody('data-ib-shape-pill');
