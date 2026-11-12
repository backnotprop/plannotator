import { act } from 'react';

export function hover(target: Element) {
  act(() => {
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { bubbles: type !== 'pointerenter' && type !== 'mouseenter', cancelable: true, pointerType: 'mouse', clientX: 10, clientY: 10 } as PointerEventInit));
    }
  });
}

export function unhover(target: Element) {
  act(() => {
    for (const type of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { bubbles: type !== 'pointerleave' && type !== 'mouseleave', cancelable: true, pointerType: 'mouse', clientX: 400, clientY: 400 } as PointerEventInit));
    }
  });
}

export async function armTip<T extends Element>(find: () => T): Promise<T> {
  hover(find());
  await settle(0);
  const node = find();
  unhover(node);
  return node;
}

export async function settle(ms = 400) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

export function openTooltips(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-side]')]
    .filter((el) => el.className.includes('bg-popover') && !el.closest('[role="menu"]') && el.getAttribute('role') !== 'menu')
    .filter((el) => !el.hasAttribute('data-ending-style') && !el.hasAttribute('data-closed'))
    .map((el) => el.textContent ?? '');
}

export async function tooltipOf(target: Element, ms = 400): Promise<string | null> {
  hover(target);
  await settle(ms);
  const tips = openTooltips();
  return tips.length > 0 ? tips[tips.length - 1]! : null;
}

export function sized(node: Element, scroll: number, client: number) {
  Object.defineProperty(node, 'scrollWidth', { configurable: true, get: () => scroll });
  Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => client });
}
