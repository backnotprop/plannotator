import type { Tooltip } from "@base-ui/react/tooltip";
import { useCallback, useLayoutEffect, useRef } from "react";

import { CollapsibleEdge, ResizeHandle } from "./CollapsibleEdge";
import { useResizablePanel } from "./useResizablePanel";
import { paneGutters } from "../stack";

export const LIST_COLUMN_MIN = 380;
export const READING_PANE_MIN = 480;
export const LIST_COLUMN_WIDTH_KEY = "plannotator-inbox-list-width";

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
	const container = useCallback(() => edge.current?.parentElement?.parentElement, []);
	const resize = useResizablePanel({
		storageKey: LIST_COLUMN_WIDTH_KEY,
		defaultWidth: LIST_COLUMN_MIN,
		minWidth: LIST_COLUMN_MIN,
		maxWidth: Number.POSITIVE_INFINITY,
		reserveViewport: READING_PANE_MIN + paneGutters(),
		container,
		side: "left",
		apply: (w) => {
			const column = columnOf();
			if (column) column.style.width = `${w}px`;
		},
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

	const value = Math.min(resize.width, resize.maxWidth);
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
