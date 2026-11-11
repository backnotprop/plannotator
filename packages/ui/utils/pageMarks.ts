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

const holders = new WeakMap<Element, Map<string, number>>();

/** Put `name` (an empty attribute) on `el` until the returned release runs. */
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
 * Hold `name` on every ancestor of `node` that matches `scope` (not `node` itself): the elements
 * `scope:has(…)` matches while `node` is in the page.
 */
export function holdPageMarkAbove(node: Element, scope: string, name: string): () => void {
  const releases: (() => void)[] = [];
  for (let el = node.parentElement; el; el = el.parentElement) if (el.matches(scope)) releases.push(holdPageMark(el, name));
  return () => {
    for (const release of releases) release();
  };
}
