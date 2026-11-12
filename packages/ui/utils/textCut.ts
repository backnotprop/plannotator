export function isTextCut(el: Element | null | undefined, partSelector?: string): boolean {
  if (typeof HTMLElement === 'undefined' || !(el instanceof HTMLElement)) return false;
  const part = partSelector ? el.querySelector<HTMLElement>(partSelector) : null;
  if (part && overflows(part)) return true;
  return overflows(el);
}

function overflows(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight + 1) return true;
  if (el.clientWidth === 0 || typeof document.createRange !== 'function') return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  const text = range.getBoundingClientRect?.().width ?? 0;
  if (!(text > 0)) return false;
  const style = getComputedStyle(el);
  if (style.overflowX === 'visible') return false;
  const box = el.getBoundingClientRect().width;
  const inner = box - num(style.paddingLeft) - num(style.paddingRight) - num(style.borderLeftWidth) - num(style.borderRightWidth);
  return text > inner + 0.01;
}

function num(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function noHover(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches;
}
