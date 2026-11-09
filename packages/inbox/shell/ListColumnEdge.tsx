// The list column's resize edge, beside an open thread (the owner,
// 2026-10-11: "adjustable just like the other sidebar, using the same
// components"). It is the sidebar's edge: the same resize hook, the same
// CollapsibleEdge separator (arrow keys, Home/End, announced range) and the
// same ResizeHandle. Beside an open thread a click on it (or Enter/Space)
// hides the list, as the sidebar's edge closes the sidebar (the owner,
// 2026-11-09): `onCollapse`, the thread in full screen. The width persists in
// a cookie, as the sidebar's does.

import type { Tooltip } from "@base-ui/react/tooltip";
import { useCallback, useLayoutEffect, useRef } from "react";

import { CollapsibleEdge, ResizeHandle } from "./CollapsibleEdge";
import { useResizablePanel } from "./useResizablePanel";
import { paneGutters } from "../stack";

/** The list's width beside a thread before it was resizable: the floor, so it never gets narrower than it was. */
export const LIST_COLUMN_MIN = 380;
/** The room the thread pane keeps beside a widened list. */
export const READING_PANE_MIN = 480;
export const LIST_COLUMN_WIDTH_KEY = "plannotator-inbox-list-width";

/**
 * Draws the edge on the list column's right side (render it inside the
 * column: its parent element is the column) and sets the column's width.
 * Drag frames write the width straight to the column's style (no render per
 * frame); the committed width lands there too. Mounted only while a pane is
 * beside the list (a thread, the thread panel) and the window is not a phone's;
 * unmounting hands the width back to the stylesheet.
 */
export function ListColumnEdge({ controls, onCollapse }: { controls?: string; onCollapse?: () => void }) {
	// The edge's own element, not a ref from the list: a child's ref is set
	// before its layout effects run, a parent's only after them.
	const edge = useRef<HTMLDivElement>(null);
	const columnOf = () => edge.current?.parentElement ?? null;
	// The edge stays drawn (hidden) under the thread in full screen: its tooltip goes with the click at once. Left to
	// close on its own, it mounts again after the press in its closing state and stays over the thread.
	const tip = useRef<Tooltip.Root.Actions | null>(null);
	const hide = onCollapse
		? () => {
				tip.current?.close();
				tip.current?.unmount();
				onCollapse();
			}
		: undefined;
	// A press focuses what it presses; the hook's pointerdown cancels that, so a click focuses the edge itself (with no
	// ring), and focus then follows to the thread's ‹ Inbox as it does from Enter on the edge.
	const clickHide = hide
		? () => {
				const separator = edge.current?.querySelector<HTMLElement>('[role="separator"]');
				if (separator && document.activeElement !== separator) separator.focus({ preventScroll: true, focusVisible: false });
				hide();
			}
		: undefined;
	// The column shares `.ib-main` with the thread pane: that is the room.
	const container = useCallback(() => edge.current?.parentElement?.parentElement, []);
	const resize = useResizablePanel({
		storageKey: LIST_COLUMN_WIDTH_KEY,
		defaultWidth: LIST_COLUMN_MIN,
		minWidth: LIST_COLUMN_MIN,
		// No cap of its own: the thread pane's minimum is the only limit.
		maxWidth: Number.POSITIVE_INFINITY,
		// The floating panes' gutters, when the Soft panes switch is on (inbox.css: max-width: calc(100% - 480px - var(--ib-gutter))).
		reserveViewport: READING_PANE_MIN + paneGutters(),
		container,
		side: "left",
		apply: (w) => {
			const column = columnOf();
			if (column) column.style.width = `${w}px`;
		},
		// Threshold-gated (4px), as the sidebar's: a click hides the list, a drag resizes it.
		onClick: clickHide,
	});

	useLayoutEffect(() => {
		const column = columnOf();
		if (column) column.style.width = `${resize.width}px`;
	}, [resize.width]);
	useLayoutEffect(() => {
		const column = columnOf();
		return () => {
			if (column) column.style.width = "";
		};
	}, []);

	// The stylesheet keeps the reading pane's room after the window narrows;
	// the separator announces the width that is drawn.
	const value = Math.min(resize.width, resize.maxWidth);
	// No room to widen into (the window leaves the pane less than 480px beside
	// a 380px list): no separator, rather than one that cannot move, unless a
	// click on it hides the list (then it only hides). The wrapper stays, so
	// the edge comes back when the room does.
	const room = resize.maxWidth > resize.minWidth;
	return (
		<div ref={edge} className="ib-listedge">
			{(room || onCollapse) && (
				<CollapsibleEdge
					label="List width"
					onCollapse={hide}
					tipActions={tip}
					collapseTip={room ? "Click to hide the list, drag to resize" : "Click to hide the list"}
					controls={controls}
					isDragging={resize.isDragging}
					resize={{ value, min: resize.minWidth, max: resize.maxWidth, resizeTo: resize.resizeTo }}
				>
					<ResizeHandle {...resize.handleProps} />
				</CollapsibleEdge>
			)}
		</div>
	);
}
