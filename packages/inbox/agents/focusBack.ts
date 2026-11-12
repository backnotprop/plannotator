export function focusBackTo(anchor: HTMLElement, popupSelector: string): () => HTMLElement | false {
  return () => {
    const active = document.activeElement;
    if (!active || active === document.body || active === anchor || active.closest(popupSelector)) return anchor;
    return false;
  };
}
