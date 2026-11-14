import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [role="button"], [role="switch"], [role="tab"], [role="radio"]';

function items(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[data-roving-skip], [hidden]'));
}

export function useRovingToolbar(ref: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    let current: HTMLElement | null = null;
    const sync = () => {
      const list = items(root);
      if (!current || !list.includes(current)) current = list[0] ?? null;
      for (const el of list) {
        const want = el === current ? '0' : '-1';
        if (el.getAttribute('tabindex') !== want) el.setAttribute('tabindex', want);
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      const list = items(root);
      const hit = list.find((el) => el === target || el.contains(target));
      if (hit && hit !== current) {
        current = hit;
        sync();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
      if (event.altKey || event.metaKey || event.ctrlKey) return;
      const list = items(root);
      const index = list.findIndex((el) => el === document.activeElement);
      if (index === -1) return;
      event.preventDefault();
      event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
      current = list[next];
      sync();
      current.focus();
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('keydown', onKeyDown);
    return () => {
      observer.disconnect();
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('keydown', onKeyDown);
    };
  }, [ref, enabled]);
}
