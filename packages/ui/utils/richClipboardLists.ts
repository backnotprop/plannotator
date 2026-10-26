interface ListFrame {
  level: number;
  kind: 'ol' | 'ul';
  list: HTMLOListElement | HTMLUListElement;
  lastItem: HTMLLIElement | null;
}

/** Restore semantic lists in a cloned Markdown selection before sanitization. */
export function restoreClipboardLists(fragment: ParentNode): void {
  const output = document.createDocumentFragment();
  const stack: ListFrame[] = [];

  for (const node of Array.from(fragment.childNodes)) {
    const levelText = node instanceof Element ? node.getAttribute('data-rich-list-level') : null;
    const kind = node instanceof Element ? node.getAttribute('data-rich-list-kind') : null;
    const level = levelText === null ? -1 : Number(levelText);
    if (!(node instanceof Element) || !Number.isSafeInteger(level) || level < 0 || (kind !== 'ol' && kind !== 'ul')) {
      stack.length = 0;
      if (node instanceof Element) restoreClipboardLists(node);
      output.appendChild(node);
      continue;
    }

    while (stack.length && stack[stack.length - 1].level > level) stack.pop();
    let current = stack[stack.length - 1];
    if (current?.level === level && current.kind !== kind) {
      stack.pop();
      current = stack[stack.length - 1];
    }

    const indexText = node.getAttribute('data-rich-list-index');
    const index = indexText === null ? null : Number(indexText);
    if (!current || current.level < level) {
      const list = document.createElement(kind);
      if (kind === 'ol' && index !== null && Number.isSafeInteger(index)) {
        list.setAttribute('start', String(index));
      }
      (current?.lastItem ?? output).appendChild(list);
      current = { level, kind, list, lastItem: null };
      stack.push(current);
    }

    const item = document.createElement('li');
    if (kind === 'ol' && index !== null && Number.isSafeInteger(index)) {
      item.setAttribute('value', String(index));
    }
    const checked = node.getAttribute('data-rich-list-checked');
    if (checked === 'true' || checked === 'false') {
      item.appendChild(document.createTextNode(checked === 'true' ? '☑ ' : '☐ '));
    }
    while (node.firstChild) item.appendChild(node.firstChild);
    current.list.appendChild(item);
    current.lastItem = item;
  }

  fragment.replaceChildren(output);
}
