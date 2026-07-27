/** Elements whose text must not become part of a document annotation range. */
const NON_ANNOTATABLE_SELECTOR = [
  'button',
  'input',
  'textarea',
  'select',
  'script',
  'style',
  '[contenteditable]:not([contenteditable="false"])',
  '[data-pinpoint-ignore]',
  '.select-none',
  '.annotation-toolbar',
  '.katex',
].join(',');

const DOCUMENT_KEYBOARD_CONTROL_SELECTOR = [
  'button',
  'input',
  'textarea',
  'select',
  'a[href]',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="dialog"]',
].join(',');

/**
 * Return the annotatable text nodes under an element in document order.
 * Existing highlight wrappers remain eligible so Vim selections can overlap
 * annotations just like pointer selections.
 */
export function getAnnotatableTextNodes(element: Element): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest(NON_ANNOTATABLE_SELECTOR)) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.textContent?.length
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  let node = walker.nextNode();
  while (node) {
    if (node instanceof Text) nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

/**
 * Return whether a keyboard event originated in an editable or interactive
 * control that must retain ownership of ordinary typing keys.
 */
export function isDocumentKeyboardControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.matches(DOCUMENT_KEYBOARD_CONTROL_SELECTOR)
    || target.closest(DOCUMENT_KEYBOARD_CONTROL_SELECTOR) !== null
    || (target instanceof HTMLElement && target.isContentEditable);
}

/**
 * Create a text-node-anchored range spanning an element's annotatable text.
 * Web-highlighter cannot paint element-node endpoints, so callers share this
 * conversion instead of synthesizing subtly different ranges.
 */
export function createTextRange(element: HTMLElement): Range | null {
  const nodes = getAnnotatableTextNodes(element);
  const firstNode = nodes[0];
  const lastNode = nodes[nodes.length - 1];

  if (!firstNode || !lastNode) return null;

  const range = document.createRange();
  range.setStart(firstNode, 0);
  range.setEnd(lastNode, lastNode.length);
  return range;
}
