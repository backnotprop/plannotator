import {
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  addScrollViewportListener,
  getScrollViewportRect,
  useScrollViewport,
} from '../hooks/useScrollViewport';
import type { SemanticTarget } from '../utils/blockTargeting';
import {
  createRangeBetweenTextPositions,
  resolveTextPosition,
  type VimRestorableState,
  type VimSelectionState,
} from '../utils/vimNavigation';
import type { VimHudCommand } from '../utils/vimHud';
import { getVimReticleLabel } from '../utils/vimReticle';

const CORNER_SIZE = 28;
const MIN_TARGET_WIDTH = 44;
const MIN_TARGET_HEIGHT = 32;
const TARGET_PADDING_X = 5;
const TARGET_PADDING_Y = 4;

interface ReticlePosition {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly labelTop: number;
}

/** Live document geometry and command context required by the Vim target reticle. */
export interface VimTargetReticleProps {
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly state: VimSelectionState;
  readonly target: SemanticTarget | null;
  readonly command: VimHudCommand | null;
}

function effectiveState(state: VimSelectionState): VimRestorableState | null {
  if (state.phase === 'inactive') return null;
  return state.phase === 'action' ? state.returnTo : state;
}

function getRangeRect(range: Range): DOMRect | null {
  let rects: DOMRect[] = [];
  if (typeof range.getClientRects === 'function') {
    try {
      rects = Array.from(range.getClientRects());
    } catch {
      rects = [];
    }
  }
  const visibleRects = rects.filter((rect) => rect.width > 0 || rect.height > 0);
  if (visibleRects.length === 0) {
    if (typeof range.getBoundingClientRect !== 'function') return null;
    try {
      return range.getBoundingClientRect();
    } catch {
      return null;
    }
  }

  const left = Math.min(...visibleRects.map((rect) => rect.left));
  const top = Math.min(...visibleRects.map((rect) => rect.top));
  const right = Math.max(...visibleRects.map((rect) => rect.right));
  const bottom = Math.max(...visibleRects.map((rect) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

function getNativeSelectionRect(container: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (
    !container.contains(range.startContainer)
    || !container.contains(range.endContainer)
  ) {
    return null;
  }
  return getRangeRect(range);
}

function getTargetRect(
  container: HTMLElement,
  state: VimRestorableState,
  target: SemanticTarget | null,
): DOMRect | null {
  if (state.phase === 'block' || state.phase === 'inline') {
    return target?.element.getBoundingClientRect() ?? null;
  }

  if (state.phase === 'visual') {
    const range = createRangeBetweenTextPositions(
      container,
      state.anchor,
      state.cursor,
    );
    return range ? getRangeRect(range) : null;
  }

  if (state.phase === 'visual-block') {
    return getNativeSelectionRect(container);
  }

  const point = resolveTextPosition(container, state.cursor);
  if (!point) return null;
  const range = document.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  const rect = getRangeRect(range);
  if (!rect) return null;

  const parent = point.node.parentElement;
  const lineHeight = parent
    ? Number.parseFloat(getComputedStyle(parent).lineHeight)
    : Number.NaN;
  return new DOMRect(
    rect.left,
    rect.top,
    Math.max(rect.width, 1),
    rect.height || lineHeight || 18,
  );
}

function relativePosition(
  targetRect: DOMRect,
  containerRect: DOMRect,
  compact: boolean,
  minimumLabelViewportTop: number,
): ReticlePosition {
  const paddingX = compact ? 10 : TARGET_PADDING_X;
  const paddingY = compact ? 6 : TARGET_PADDING_Y;
  const naturalWidth = targetRect.width + paddingX * 2;
  const naturalHeight = targetRect.height + paddingY * 2;
  const width = Math.max(MIN_TARGET_WIDTH, naturalWidth);
  const height = Math.max(MIN_TARGET_HEIGHT, naturalHeight);
  const targetCenterX = targetRect.left - containerRect.left + targetRect.width / 2;
  const targetCenterY = targetRect.top - containerRect.top + targetRect.height / 2;
  const left = Math.max(0, targetCenterX - width / 2);
  const top = Math.max(0, targetCenterY - height / 2);
  const aboveLabelTop = top - 36;

  return {
    left,
    top,
    width,
    height,
    labelTop: aboveLabelTop + containerRect.top >= minimumLabelViewportTop
      ? aboveLabelTop
      : Math.max(
          top + height + 6,
          minimumLabelViewportTop - containerRect.top,
        ),
  };
}

/**
 * Draw the video HUD's targeting treatment on top of the real Vim target.
 *
 * Geometry always comes from the live semantic element, caret, or browser
 * selection. The overlay never owns focus and never participates in layout.
 */
export function VimTargetReticle({
  containerRef,
  state,
  target,
  command,
}: VimTargetReticleProps) {
  const [position, setPosition] = useState<ReticlePosition | null>(null);
  const rafRef = useRef(0);
  const scrollViewport = useScrollViewport();
  const restoredState = effectiveState(state);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !restoredState) {
      setPosition(null);
      return;
    }

    const update = () => {
      const targetRect = getTargetRect(container, restoredState, target);
      if (!targetRect) {
        setPosition(null);
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const viewportTop = scrollViewport
        ? getScrollViewportRect(scrollViewport).top
        : containerRect.top;
      const stickyBottom = container
        .querySelector<HTMLElement>('[data-sticky-actions]')
        ?.getBoundingClientRect()
        .bottom;
      setPosition(relativePosition(
        targetRect,
        containerRect,
        restoredState.phase === 'text',
        Math.max(viewportTop + 4, stickyBottom ? stickyBottom + 6 : 0),
      ));
    };
    const scheduleUpdate = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(update);
    };

    update();
    window.addEventListener('resize', scheduleUpdate, { passive: true });
    const removeScrollListener = scrollViewport
      ? addScrollViewportListener(scrollViewport, scheduleUpdate)
      : undefined;
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(container);
    if (target?.element) resizeObserver?.observe(target.element);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', scheduleUpdate);
      removeScrollListener?.();
      resizeObserver?.disconnect();
    };
  }, [containerRef, restoredState, scrollViewport, target]);

  if (!position || !restoredState) return null;

  const label = getVimReticleLabel(restoredState, target, command);
  const cornerRight = Math.max(0, position.width - CORNER_SIZE);
  const cornerBottom = Math.max(0, position.height - CORNER_SIZE);
  const fillTransform = `translate3d(${position.left}px, ${position.top}px, 0) scale(${
    position.width / 100
  }, ${position.height / 100})`;

  return (
    <div
      data-vim-target-reticle
      data-vim-target-label={label}
      data-vim-target-phase={restoredState.phase}
      aria-hidden="true"
      className="vim-target-reticle"
    >
      <div
        data-vim-target-fill
        className="vim-target-reticle__fill"
        style={{ transform: fillTransform }}
      />
      <div
        data-vim-target-corner="top-left"
        className="vim-target-reticle__corner vim-target-reticle__corner--top-left"
        style={{ transform: `translate3d(${position.left}px, ${position.top}px, 0)` }}
      />
      <div
        data-vim-target-corner="top-right"
        className="vim-target-reticle__corner vim-target-reticle__corner--top-right"
        style={{
          transform: `translate3d(${position.left + cornerRight}px, ${position.top}px, 0)`,
        }}
      />
      <div
        data-vim-target-corner="bottom-left"
        className="vim-target-reticle__corner vim-target-reticle__corner--bottom-left"
        style={{
          transform: `translate3d(${position.left}px, ${position.top + cornerBottom}px, 0)`,
        }}
      />
      <div
        data-vim-target-corner="bottom-right"
        className="vim-target-reticle__corner vim-target-reticle__corner--bottom-right"
        style={{
          transform: `translate3d(${
            position.left + cornerRight
          }px, ${position.top + cornerBottom}px, 0)`,
        }}
      />
      <div
        data-vim-target-label
        className="vim-target-reticle__label"
        style={{
          transform: `translate3d(${position.left}px, ${position.labelTop}px, 0)`,
        }}
      >
        <span className="vim-target-reticle__label-dot" />
        <span>{label}</span>
      </div>
    </div>
  );
}
