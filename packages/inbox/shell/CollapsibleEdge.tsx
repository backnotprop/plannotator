// Ported from Workspaces apps/web/src/components/CollapsibleEdge.tsx
// (68afaf421) and apps/web/src/components/ResizeHandle.tsx (227b573f2) for the
// Inbox sidebar (the owner, 2026-10-09: the same component and motion). Port:
// Base UI's Tooltip directly (Workspaces wraps it in its ui kit), Tailwind
// classes became `ib-` classes in inbox.css, and only the left side is kept.

import { Tooltip } from "@base-ui/react/tooltip";
import type { KeyboardEvent, ReactNode } from "react";

import type { ResizeHandleProps } from "./useResizablePanel";

/** Keyboard resize contract for an edge: arrow keys in 10px steps, Home/End
 * to the range ends, clamped to the viable range; the pointer-only dismissal
 * threshold never applies to keyboard resizing. */
export interface EdgeKeyboardResize {
	/** Current committed width (px): becomes aria-valuenow. */
	value: number;
	min: number;
	max: number;
	resizeTo: (px: number) => void;
}

const KEYBOARD_STEP = 10;

/**
 * The edge's interaction chrome: hovering never pops the track in; a quiet
 * cursor-following tooltip teaches "Click to collapse, drag to resize", a
 * single click anywhere on the handle collapses (the resize hook's
 * threshold-gated `onClick`), and the handle is a real keyboard target:
 * Enter/Space collapse, ArrowLeft/Right resize in 10px steps, Home/End to the
 * range ends, announced as a separator.
 */
export function CollapsibleEdge({
	onCollapse,
	label,
	isDragging,
	resize,
	children,
}: {
	onCollapse: () => void;
	/** Accessible name for the focusable edge. */
	label: string;
	/** Mid-drag the tooltip is suppressed (the hint is for the idle edge). */
	isDragging: boolean;
	resize: EdgeKeyboardResize;
	children: ReactNode;
}) {
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onCollapse();
			return;
		}
		let target: number | undefined;
		if (e.key === "ArrowRight") target = resize.value + KEYBOARD_STEP;
		else if (e.key === "ArrowLeft") target = resize.value - KEYBOARD_STEP;
		else if (e.key === "Home") target = resize.min;
		else if (e.key === "End") target = resize.max;
		if (target === undefined) return;
		e.preventDefault();
		// resizeTo clamps to [min, max]: keyboard resizing can never dismiss.
		resize.resizeTo(target);
	};

	return (
		<Tooltip.Provider delay={300}>
			<Tooltip.Root trackCursorAxis="both">
				<Tooltip.Trigger
					render={
						<div
							role="separator"
							aria-orientation="vertical"
							aria-valuenow={Math.round(resize.value)}
							aria-valuemin={resize.min}
							aria-valuemax={resize.max}
							tabIndex={0}
							aria-label={label}
							onKeyDown={onKeyDown}
							className="ib-edge"
						/>
					}
				>
					{children}
				</Tooltip.Trigger>
				{!isDragging && (
					<Tooltip.Portal>
						<Tooltip.Positioner side="bottom" sideOffset={14} className="ib-edge-tip-pos">
							<Tooltip.Popup className="ib-edge-tip">Click to collapse, drag to resize</Tooltip.Popup>
						</Tooltip.Positioner>
					</Tooltip.Portal>
				)}
			</Tooltip.Root>
		</Tooltip.Provider>
	);
}

/**
 * The sidebar's drag handle: a zero-width boundary with a 16px invisible hit
 * area centered on it. The track stays invisible until keyboard focus
 * (`.ib-edge:focus-visible [data-resize-track]` in inbox.css).
 */
export function ResizeHandle({ onPointerDown, style }: ResizeHandleProps) {
	return (
		<div className="ib-handle">
			<div data-resize-track="left" className="ib-handle-track" />
			<div className="ib-handle-hit" style={style} onPointerDown={onPointerDown} />
		</div>
	);
}
