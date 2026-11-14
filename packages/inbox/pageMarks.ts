/**
 * The Inbox window's page marks: attributes its parts hold on the page's root or on `.pn-inbox` while they are in
 * the page, in place of the `:has()` rules inbox.css keys on them (`html:has(.pn-inbox)`, `.pn-inbox:has(.ib-dm-pill)`,
 * `body:has([data-shape-layer] .shp-dock)`, …).
 *
 * Why: Chromium has to look again at a `:has()` anchored on `html`, `body` or `.pn-inbox` whenever anything under
 * that element changes. On a long thread (hundreds of highlighted code fences, about 440,000 elements) that was about
 * 40 ms of style work for every DOM change: a fence highlighted, a message arriving, a fold. An attribute costs
 * nothing until it flips.
 *
 * inbox.css keeps its `:has()` rules: they say what each look means, and the sheet other apps load
 * (`@plannotator/ui/inbox-thread.css`) ships them as they are. The window's build rewrites each one to its mark
 * (build/inbox-page-marks.ts), keeping its specificity. Each mark is held exactly while what its `:has()` names is
 * in the page: a ref callback (React 19 runs the release when the element goes), so the mark comes and goes in the
 * same commit as the element, before the browser paints.
 */
import { holdPageMark, holdPageMarkAbove } from '@plannotator/ui/utils/pageMarks';

/** On `.pn-inbox` itself: `<html>` and `<body>` carry `data-pn-inbox` (`html:has(.pn-inbox)`, `body:has(.pn-inbox)`). */
export function markInboxPage(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  const page = holdPageMark(el.ownerDocument.documentElement, 'data-pn-inbox');
  const body = holdPageMark(el.ownerDocument.body, 'data-pn-inbox');
  return () => {
    page();
    body();
  };
}

/** A ref for an element a `.pn-inbox:has(…)` rule keys on: each `.pn-inbox` above it carries `name`. */
const aboveInbox = (name: string) => (el: HTMLElement | null) => (el ? holdPageMarkAbove(el, '.pn-inbox', name) : undefined);

/** `.ib-dm-pill`: `.pn-inbox:has(.ib-dm-pill)`. */
export const markDecisionPill = aboveInbox('data-ib-dm-pill');
/** `.ib-imgcompose`: `.pn-inbox:has(.ib-imgcompose)`. */
export const markImageComposer = aboveInbox('data-ib-imgcompose');
/** `.ib-fcomp`: `.pn-inbox:has(.ib-fcomp)`. */
export const markFullScreenComposer = aboveInbox('data-ib-fcomp');
/** `.ib-rpick`: `.pn-inbox:has(.ib-rpick)`. */
export const markRecipientList = aboveInbox('data-ib-rpick');

/** A ref for a part of a Shape board, inside the window's `[data-shape-layer]`: `<body>` carries `name`. */
const onBody = (name: string) => (el: HTMLElement | null) => (el ? holdPageMark(el.ownerDocument.body, name) : undefined);

/** The board's dock: `body:has([data-shape-layer] .shp-dock)`. */
export const markShapeDock = onBody('data-ib-shape-dock');
/** The board's update pill: `body:has([data-shape-layer] .shp-pill)`. */
export const markShapePill = onBody('data-ib-shape-pill');
