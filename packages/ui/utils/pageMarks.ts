/**
 * Page marks (opt-in, `configurePlannotatorUI({ pageMarks: true })`): an attribute ui puts on the page's root
 * (`<html>` or `<body>`) while one of its parts is there, so a host's stylesheet can key on the attribute instead
 * of a `:has()` on the root.
 *
 * Why: Chromium has to look again at a `:has()` anchored on `html` or `body` whenever anything under it changes,
 * and on a long page (a thread of hundreds of highlighted code fences, about 440,000 elements) that is a pass
 * over the whole document for every DOM change: about 40 ms of style work per change. An attribute costs nothing
 * until it flips.
 *
 * With the flag on, ui marks:
 * - `<body data-pn-popout>` while a `PopoutDialog`'s dialog (`[data-popout="true"]`) is in the page: what
 *   theme.css's `body:has([data-popout="true"])` matches;
 * - `<html data-pn-selection-chooser>` while review-editor's `SelectionChooser` carries
 *   `[data-selection-chooser]`: what comments.css's `html:has([data-selection-chooser])` matches.
 *
 * The stylesheets keep their `:has()` rules, so a host that leaves the flag off sees no change and needs no new
 * rule. A host that turns it on rewrites those selectors to the marks in its own build (the Plannotator Inbox:
 * build/inbox-page-marks.ts).
 */

let pageMarks = false;

export function setPageMarks(on: boolean): void {
  pageMarks = on;
}

export function resetPageMarks(): void {
  pageMarks = false;
}

export function getPageMarks(): boolean {
  return pageMarks;
}

/** How many holders each element's marks have: two parts that hold one mark keep it until both are gone. */
const holders = new WeakMap<Element, Map<string, number>>();

/**
 * Put `name` (an empty attribute) on `el` until the returned release runs. Holds count: the attribute goes with
 * the last release. A release runs once, however often it is called.
 */
export function holdPageMark(el: Element, name: string): () => void {
  let counts = holders.get(el);
  if (!counts) holders.set(el, (counts = new Map()));
  const held = counts.get(name) ?? 0;
  counts.set(name, held + 1);
  if (held === 0) el.setAttribute(name, '');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (counts.get(name) ?? 1) - 1;
    if (left > 0) counts.set(name, left);
    else {
      counts.delete(name);
      el.removeAttribute(name);
    }
  };
}

/**
 * Hold `name` on every ancestor of `node` that matches `scope` (not `node` itself): the elements `scope:has(…)`
 * matches while `node` is in the page.
 */
export function holdPageMarkAbove(node: Element, scope: string, name: string): () => void {
  const releases: (() => void)[] = [];
  for (let el = node.parentElement; el; el = el.parentElement) if (el.matches(scope)) releases.push(holdPageMark(el, name));
  return () => {
    for (const release of releases) release();
  };
}
