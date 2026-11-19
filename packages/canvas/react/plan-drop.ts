/**
 * Dragging a snapshot from the canvas into a plan, to a place between two
 * blocks. The plan side needs nothing but two attributes: a container
 * marked `data-pcv-plan-drop` and blocks carrying `data-block-id` (the
 * product's block renderer already writes the second).
 *
 * `nearestGap` is the pure part; `beginPlanDrag` is the pointer plumbing.
 */

export interface PlanDropTarget {
  blockId: string;
  place: 'before' | 'after';
}

export interface BlockBox {
  id: string;
  top: number;
  bottom: number;
}

/**
 * The gap between blocks nearest to `y`: before the first block, after the
 * last, or between two. `at` is where to draw the line. Null for no blocks.
 */
export function nearestGap(blocks: readonly BlockBox[], y: number): (PlanDropTarget & { at: number }) | null {
  if (blocks.length === 0) return null;
  const sorted = [...blocks].sort((a, b) => a.top - b.top);
  let best: (PlanDropTarget & { at: number }) | null = null;
  let bestDistance = Infinity;
  const consider = (target: PlanDropTarget, at: number) => {
    const distance = Math.abs(at - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { ...target, at };
    }
  };
  consider({ blockId: sorted[0].id, place: 'before' }, sorted[0].top - 6);
  for (let i = 0; i < sorted.length; i++) {
    const next = sorted[i + 1];
    consider({ blockId: sorted[i].id, place: 'after' }, next ? (sorted[i].bottom + next.top) / 2 : sorted[i].bottom + 6);
  }
  return best;
}

export interface PlanDragOptions {
  /** What the dragged chip says. */
  label: string;
  /** Marks a place snapshots can be dropped. */
  zoneSelector?: string;
  blockSelector?: string;
  /** A class for the chip and the line, so they take the canvas's theme. */
  className?: string;
  onDrop: (target: PlanDropTarget) => void;
  /**
   * The press ended without becoming a drag. The button's own click handler
   * should then act only for a keyboard press (`event.detail === 0`), so one
   * press is never counted twice.
   */
  onClick?: () => void;
}

const SLOP = 6;

/**
 * Follow a press that began on the "Add to plan" button. Past a few pixels
 * it becomes a drag: a chip follows the pointer and a line shows where the
 * snapshot would land. Releasing over a plan drops it there; releasing
 * anywhere else, or a cancelled pointer, does nothing.
 */
export function beginPlanDrag(start: PointerEvent, options: PlanDragOptions): void {
  const zoneSelector = options.zoneSelector ?? '[data-pcv-plan-drop]';
  const blockSelector = options.blockSelector ?? '[data-block-id]';
  const origin = { x: start.clientX, y: start.clientY };
  let ghost: HTMLElement | null = null;
  let line: HTMLElement | null = null;
  let target: PlanDropTarget | null = null;
  let dragging = false;

  const zoneAt = (x: number, y: number): HTMLElement | null => {
    for (const zone of document.querySelectorAll<HTMLElement>(zoneSelector)) {
      const box = zone.getBoundingClientRect();
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return zone;
    }
    return null;
  };

  const move = (event: PointerEvent) => {
    if (event.pointerId !== start.pointerId) return;
    if (!dragging) {
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < SLOP) return;
      dragging = true;
      ghost = document.createElement('div');
      ghost.className = `pcv pcv-drag-ghost ${options.className ?? ''}`.trim();
      ghost.textContent = options.label;
      line = document.createElement('div');
      line.className = `pcv pcv-drop-line ${options.className ?? ''}`.trim();
      line.hidden = true;
      document.body.append(line, ghost);
    }
    event.preventDefault();
    ghost!.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 14}px)`;
    const zone = zoneAt(event.clientX, event.clientY);
    const gap = zone
      ? nearestGap(
          [...zone.querySelectorAll<HTMLElement>(blockSelector)].map((el) => {
            const box = el.getBoundingClientRect();
            return { id: el.dataset.blockId ?? '', top: box.top, bottom: box.bottom };
          }),
          event.clientY,
        )
      : null;
    if (zone && gap) {
      const box = zone.getBoundingClientRect();
      const inset = 16;
      target = { blockId: gap.blockId, place: gap.place };
      line!.hidden = false;
      line!.style.width = `${Math.max(0, box.width - inset * 2)}px`;
      line!.style.transform = `translate(${box.left + inset}px, ${Math.max(box.top, Math.min(box.bottom, gap.at))}px)`;
    } else {
      target = null;
      line!.hidden = true;
    }
  };

  const finish = (drop: boolean) => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    ghost?.remove();
    line?.remove();
    if (!dragging) {
      if (drop) options.onClick?.();
      return;
    }
    if (drop && target) options.onDrop(target);
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId === start.pointerId) finish(true);
  };
  const cancel = (event: PointerEvent) => {
    if (event.pointerId === start.pointerId) finish(false);
  };

  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
}
