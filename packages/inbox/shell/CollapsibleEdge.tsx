// Ported from the Workspaces app's CollapsibleEdge and ResizeHandle components
// for the Inbox sidebar (the owner, 2026-10-09: the same component and
// motion). Port: Base UI's Tooltip directly (Workspaces wraps it in its ui
// kit), Tailwind classes became `ib-` classes in inbox.css, and only the left
// side is kept.

import { Tooltip } from "@base-ui/react/tooltip";
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";

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

/** The tip waits this long on the edge, so a pointer passing through on its way to a row does not open it. */
export const EDGE_TIP_DELAY_MS = 600;

/**
 * The edge's interaction chrome: hovering never pops the track in; a quiet
 * cursor-following tooltip teaches "Click to collapse, drag to resize", a
 * single click anywhere on the handle collapses (the resize hook's
 * threshold-gated `onClick`), and the handle is a real keyboard target:
 * Enter/Space collapse, ArrowLeft/Right resize in 10px steps, Home/End to the
 * range ends, announced as a separator.
 *
 * Inbox addition: without `onCollapse` (the list column beside an open
 * thread, which has nothing to collapse to) the edge only resizes: Enter and
 * Space do nothing and the tooltip says "Drag to resize".
 *
 * Inbox addition: the tip follows the cursor up and down only and sits on the
 * left, over the panel the edge resizes (the sidebar, the list), never over
 * the rows beside it; it waits 600 ms, and it closes when its edge goes away.
 */
export function CollapsibleEdge({
	onCollapse,
	collapseTip = "Click to collapse, drag to resize",
	label,
	controls,
	isDragging,
	resize,
	tipActions,
	children,
}: {
	onCollapse?: () => void;
	/** The tooltip while `onCollapse` is set (the list column says what it hides). */
	collapseTip?: string;
	/** Accessible name for the focusable edge. */
	label: string;
	/** The id of the panel the edge resizes (aria-controls). */
	controls?: string;
	/** Mid-drag the tooltip is suppressed (the hint is for the idle edge). */
	isDragging: boolean;
	resize: EdgeKeyboardResize;
	/** Inbox addition: closes the tooltip from outside (the list's edge stays drawn, hidden, after its click hides the list). */
	tipActions?: RefObject<Tooltip.Root.Actions | null>;
	children: ReactNode;
}) {
	const own = useRef<Tooltip.Root.Actions | null>(null);
	const actions = tipActions ?? own;
	// A layout cleanup: it runs before the tooltip's own handle is let go.
	useLayoutEffect(
		() => () => {
			actions.current?.close();
			actions.current?.unmount();
		},
		[],
	);
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (onCollapse && (e.key === "Enter" || e.key === " ")) {
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
		<Tooltip.Provider delay={EDGE_TIP_DELAY_MS}>
			<Tooltip.Root trackCursorAxis="y" actionsRef={actions}>
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
							aria-controls={controls}
							onKeyDown={onKeyDown}
							className="ib-edge"
						/>
					}
				>
					{children}
				</Tooltip.Trigger>
				{!isDragging && (
					<Tooltip.Portal>
						<Tooltip.Positioner side="left" sideOffset={14} className="ib-edge-tip-pos">
							<Tooltip.Popup className="ib-edge-tip">
								{onCollapse ? collapseTip : "Drag to resize"}
							</Tooltip.Popup>
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
