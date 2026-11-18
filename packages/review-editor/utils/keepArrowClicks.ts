const opensLines = (node: EventTarget) => node instanceof Element && (node.hasAttribute('data-expand-button') || node.hasAttribute('data-unmodified-lines'));

export function keepArrowClicks(scroller: HTMLElement): () => void {
  let press: { x: number; y: number; host: HTMLElement } | null = null;
  const down = (event: PointerEvent) => {
    press = null;
    if (event.pointerType === 'touch' || event.button !== 0) return;
    const path = event.composedPath();
    if (!path.some(opensLines)) return;
    const host = path.find((node): node is HTMLElement => node instanceof HTMLElement && node.tagName === 'DIFFS-CONTAINER');
    if (host) press = { x: event.clientX, y: event.clientY, host };
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
    const { clientX, clientY } = event;
    setTimeout(() => {
      if (press !== pressed) return;
      press = null;
      const under = pressed.host.shadowRoot?.elementFromPoint(clientX, clientY);
      let target: Element | null | undefined = under;
      while (target && !opensLines(target)) target = target.parentElement;
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true, clientX, clientY, button: 0, detail: 1, view: window }));
    }, 0);
  };
  scroller.addEventListener('pointerdown', down, { capture: true, passive: true });
  scroller.addEventListener('click', click, { capture: true });
  window.addEventListener('pointerup', up, { capture: true });
  return () => {
    scroller.removeEventListener('pointerdown', down, { capture: true });
    scroller.removeEventListener('click', click, { capture: true });
    window.removeEventListener('pointerup', up, { capture: true });
  };
}
