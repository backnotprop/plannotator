/** Focus returns to the agent's mark on close unless the person already moved it elsewhere while the picker faded out. */
export function focusBackTo(anchor: HTMLElement, popupSelector: string): () => HTMLElement | false {
  return () => {
    const active = document.activeElement;
    if (!active || active === document.body || active === anchor || active.closest(popupSelector)) return anchor;
    return false;
  };
}
