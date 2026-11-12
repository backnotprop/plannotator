export interface SelectedLinesBox {
  top: number;
  bottom: number;
  left: number;
}

export interface ReadLines extends SelectedLinesBox {
  host: Element;
  own: boolean;
  shownTop: number;
  shownBottom: number;
  roof: number;
}

export interface SelectionRange {
  start: number;
  end: number;
  side?: 'deletions' | 'additions';
  endSide?: 'deletions' | 'additions';
}

const GAP = 6;
const EDGE = 8;

const within = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));

export function placeChooser(
  lines: SelectedLinesBox,
  bar: { width: number; height: number },
  bounds: { top: number; bottom: number; left: number; right: number },
): { top: number; left: number } {
  const highest = bounds.top + EDGE;
  const lowest = bounds.bottom - EDGE - bar.height;
  const below = lines.bottom + GAP;
  const above = lines.top - GAP - bar.height;
  const top = below <= lowest ? below : above >= highest ? above : lowest;
  return { top: within(top, highest, lowest), left: within(lines.left, bounds.left + EDGE, bounds.right - EDGE - bar.width) };
}

export function linesOffScreen(lines: ReadLines, bounds: { top: number; bottom: number }): boolean {
  return lines.bottom <= Math.max(lines.shownTop, bounds.top) || lines.top >= Math.min(lines.shownBottom, bounds.bottom);
}

function shownAround(start: Element): Pick<ReadLines, 'shownTop' | 'shownBottom' | 'roof'> {
  let shownTop = -Infinity;
  let shownBottom = Infinity;
  let roof = -Infinity;
  for (let el: Element | null = start; el && el !== document.body && el !== document.documentElement; ) {
    const overflow = getComputedStyle(el).overflowY;
    if (/auto|scroll|hidden|clip/.test(overflow)) {
      const rect = el.getBoundingClientRect();
      shownTop = Math.max(shownTop, rect.top);
      shownBottom = Math.min(shownBottom, rect.bottom);
      if (overflow !== 'hidden' && overflow !== 'clip' && el.scrollHeight > el.clientHeight) roof = rect.top;
    }
    el = el.parentElement ?? (el.getRootNode() as ShadowRoot).host ?? null;
  }
  return { shownTop, shownBottom, roof };
}

function readHost(host: Element, range: SelectionRange): ReadLines | null {
  const painted = [...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-selected-line]') ?? [])];
  if (!painted.length) return null;
  const side = range.endSide ?? range.side ?? 'additions';
  const onSide = painted.filter((el) => el.closest('[data-code]')?.hasAttribute(`data-${side}`));
  const lines = onSide.length ? onSide : painted;
  const rects = lines.map((el) => el.getBoundingClientRect());
  const gutter = lines.find((el) => el.hasAttribute('data-column-number'));
  return {
    host,
    own: lines.some((el) => el.getAttribute('data-line') === String(range.end)),
    top: Math.min(...rects.map((r) => r.top)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
    left: gutter ? gutter.getBoundingClientRect().right : Math.min(...rects.map((r) => r.left)),
    ...shownAround(lines[0]!),
  };
}

export function readSelectedLines(range: SelectionRange, pointer: { top: number }, ownOnly = true, diff?: Element | null): ReadLines | null {
  if (diff) return readHost(diff, range);
  const away = (box: SelectedLinesBox) => Math.abs((box.top + box.bottom) / 2 - pointer.top);
  const boxes = [...document.querySelectorAll('diffs-container')].flatMap((host) => readHost(host, range) ?? []);
  const own = boxes.filter((box) => box.own);
  const from = own.length || ownOnly ? own : boxes;
  return from.reduce<ReadLines | null>((nearest, box) => (!nearest || away(box) < away(nearest) ? box : nearest), null);
}
