const FIRST_CHANGE_LEAD_PX = 48;

export function revealFirstChange(node: HTMLElement): boolean {
  const root = node.shadowRoot;
  if (!root) return false;
  let moved = false;
  for (const code of root.querySelectorAll<HTMLElement>('[data-code]')) {
    if (code.scrollLeft !== 0 || code.scrollWidth <= code.clientWidth) continue;
    const span = code.querySelector<HTMLElement>('[data-diff-span]');
    if (!span) continue;
    const box = code.getBoundingClientRect();
    const mark = span.getBoundingClientRect();
    // Only a change that starts out of sight is brought in. One that starts on
    // screen but runs past the right edge (a whole new long line) is already
    // seen; scrolling to it would hide the start of every line in the column.
    if (mark.left >= box.left && mark.left + FIRST_CHANGE_LEAD_PX <= box.right) continue;
    code.scrollLeft = Math.max(0, mark.left - box.left - FIRST_CHANGE_LEAD_PX);
    moved = true;
  }
  return moved;
}
