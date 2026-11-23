const opensLines = (node: EventTarget) => node instanceof Element && (node.hasAttribute('data-expand-button') || node.hasAttribute('data-unmodified-lines'));

const KINDS = ['data-expand-up', 'data-expand-down', 'data-expand-both', 'data-expand-all-button', 'data-unmodified-lines'];

function opener(target: Element | null | undefined): { element: Element; kind: string } | null {
  let element = target;
  while (element && !opensLines(element)) element = element.parentElement;
  if (!element) return null;
  const index = element.closest('[data-expand-index]')?.getAttribute('data-expand-index') ?? '';
  return { element, kind: `${index}:${KINDS.filter((name) => element.hasAttribute(name)).join(',')}` };
}

export function keepArrowClicks(scroller: HTMLElement): () => void {
  let press: { x: number; y: number; host: HTMLElement; kind: string } | null = null;
  const cancel = () => {
    press = null;
  };
  const down = (event: PointerEvent) => {
    press = null;
    if (event.pointerType !== 'mouse' || event.button !== 0 || event.ctrlKey) return;
    const path = event.composedPath();
    const pressed = opener(path.find(opensLines) as Element | undefined);
    const host = path.find((node): node is HTMLElement => node instanceof HTMLElement && node.tagName === 'DIFFS-CONTAINER');
    if (pressed && host) press = { x: event.clientX, y: event.clientY, host, kind: pressed.kind };
  };
  const click = (event: MouseEvent) => {
    if (event.composedPath().some(opensLines)) press = null;
  };
  const up = (event: PointerEvent) => {
    const pressed = press;
    if (!pressed || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 6) {
      press = null;
      return;
    }
    const { shiftKey, altKey, metaKey } = event;
    setTimeout(() => {
      if (press !== pressed) return;
      press = null;
      const found = opener(pressed.host.shadowRoot?.elementFromPoint(pressed.x, pressed.y));
      if (!found || found.kind !== pressed.kind) return;
      found.element.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, clientX: pressed.x, clientY: pressed.y, button: 0, detail: 1, view: window, shiftKey, altKey, metaKey }));
    }, 0);
  };
  scroller.addEventListener('pointerdown', down, { capture: true, passive: true });
  scroller.addEventListener('click', click, { capture: true });
  window.addEventListener('pointerup', up, { capture: true });
  window.addEventListener('contextmenu', cancel, { capture: true });
  window.addEventListener('wheel', cancel, { capture: true, passive: true });
  return () => {
    scroller.removeEventListener('pointerdown', down, { capture: true });
    scroller.removeEventListener('click', click, { capture: true });
    window.removeEventListener('pointerup', up, { capture: true });
    window.removeEventListener('contextmenu', cancel, { capture: true });
    window.removeEventListener('wheel', cancel, { capture: true });
  };
}
