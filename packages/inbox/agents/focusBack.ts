/**
 * Where focus goes when the face picker or its panel closes (Base UI's `finalFocus`, asked once the close has run its
 * course): back to the agent's mark, unless the person has already put it somewhere else (clicked a row, typed in a
 * box) while the picker faded out. A closing picker never takes focus away from where the person has moved on to.
 */
export function focusBackTo(anchor: HTMLElement, popupSelector: string): () => HTMLElement | false {
  return () => {
    const active = document.activeElement;
    if (!active || active === document.body || active === anchor || active.closest(popupSelector)) return anchor;
    return false;
  };
}
