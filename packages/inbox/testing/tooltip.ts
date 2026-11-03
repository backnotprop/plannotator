/**
 * The Inbox's tooltips (packages/inbox/components/Tip.tsx) in a DOM test:
 * rest the pointer on an element the way a mouse does, then read the
 * component tooltip it opened (ui's Tooltip, portaled out of the element).
 * happy-dom has no layout, so a test that wants a "cut" tooltip sets the
 * element's sizes with `sized` first.
 */
import { act } from 'react';

/** The pointer comes to rest on `target`. */
export function hover(target: Element) {
  act(() => {
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { bubbles: type !== 'pointerenter' && type !== 'mouseenter', cancelable: true, pointerType: 'mouse', clientX: 10, clientY: 10 } as PointerEventInit));
    }
  });
}

/** The pointer leaves `target`. */
export function unhover(target: Element) {
  act(() => {
    for (const type of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { bubbles: type !== 'pointerleave' && type !== 'mouseleave', cancelable: true, pointerType: 'mouse', clientX: 400, clientY: 400 } as PointerEventInit));
    }
  });
}

/**
 * A list row's tooltip mounts when the pointer first enters its trigger, and the trigger is drawn again then
 * (RowTip.tsx). A test that gives the trigger sizes (`sized`) arms it first: the pointer enters and leaves once, and
 * this returns the trigger as it is drawn now, still under `find`.
 */
export function armTip<T extends Element>(find: () => T): T {
  hover(find());
  const node = find();
  unhover(node);
  return node;
}

export async function settle(ms = 400) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Every component tooltip on the page now (ui's Tooltip popup), by its text. */
export function openTooltips(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-side]')]
    .filter((el) => el.className.includes('bg-popover') && !el.closest('[role="menu"]') && el.getAttribute('role') !== 'menu')
    .filter((el) => !el.hasAttribute('data-ending-style') && !el.hasAttribute('data-closed'))
    .map((el) => el.textContent ?? '');
}

/** Hover `target` and return the tooltip it opened, or null. Leaves the pointer there. */
export async function tooltipOf(target: Element, ms = 400): Promise<string | null> {
  hover(target);
  await settle(ms);
  const tips = openTooltips();
  return tips.length > 0 ? tips[tips.length - 1]! : null;
}

/** happy-dom has no layout: give an element the sizes a cut (or fitting) text would have. */
export function sized(node: Element, scroll: number, client: number) {
  Object.defineProperty(node, 'scrollWidth', { configurable: true, get: () => scroll });
  Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => client });
}
