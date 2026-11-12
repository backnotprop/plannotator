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

export function holdPageMarkAbove(node: Element, scope: string, name: string): () => void {
  const releases: (() => void)[] = [];
  for (let el = node.parentElement; el; el = el.parentElement) if (el.matches(scope)) releases.push(holdPageMark(el, name));
  return () => {
    for (const release of releases) release();
  };
}
