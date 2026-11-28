import { useEffect, useState } from 'react';

const COUNTS_COLUMN_PX = 84;

export function fitCountsColumn(list: HTMLElement, pinColumn: boolean): boolean {
  let widest = 0;
  let drawn = true;
  if (pinColumn) {
    const alike = new Map<string, HTMLElement[]>();
    for (const cell of list.querySelectorAll<HTMLElement>('.ib-row > .ib-cq')) {
      if (!cell.firstElementChild) continue;
      const key = [...cell.children].map((part) => `${part.getAttribute('class')}\t${part.textContent}`).join('\n');
      const cells = alike.get(key);
      if (cells) cells.push(cell);
      else alike.set(key, [cell]);
    }
    groups: for (const cells of alike.values()) {
      for (const cell of cells) {
        const lefts = [...cell.children].map((part) => part.getBoundingClientRect()).filter((box) => box.width > 1).map((box) => box.left);
        if (lefts.length) {
          widest = Math.max(widest, cell.getBoundingClientRect().right - Math.min(...lefts));
          break;
        }
        if (list.getClientRects().length === 0) {
          drawn = false;
          widest = 0;
          break groups;
        }
      }
    }
  }
  const width = widest > COUNTS_COLUMN_PX ? `${Math.ceil(widest)}px` : '';
  if (list.style.getPropertyValue('--ib-cq-w') !== width) {
    if (width) list.style.setProperty('--ib-cq-w', width);
    else list.style.removeProperty('--ib-cq-w');
  }
  return drawn;
}

export function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio));
  useEffect(() => {
    const read = () => setRatio(window.devicePixelRatio);
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  return ratio;
}
