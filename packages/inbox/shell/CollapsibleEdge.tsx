import { Tooltip } from "@base-ui/react/tooltip";
import type { KeyboardEvent, ReactNode, RefObject } from "react";

import type { ResizeHandleProps } from "./useResizablePanel";

export interface EdgeKeyboardResize {
	value: number;
	min: number;
	max: number;
	resizeTo: (px: number) => void;
}

const KEYBOARD_STEP = 10;

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
	collapseTip?: string;
	label: string;
	controls?: string;
	isDragging: boolean;
	resize: EdgeKeyboardResize;
	tipActions?: RefObject<Tooltip.Root.Actions | null>;
	children: ReactNode;
}) {
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
		<Tooltip.Provider delay={300}>
			<Tooltip.Root trackCursorAxis="both" actionsRef={tipActions}>
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
						<Tooltip.Positioner side="bottom" sideOffset={14} className="ib-edge-tip-pos">
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

export function ResizeHandle({ onPointerDown, style }: ResizeHandleProps) {
	return (
		<div className="ib-handle">
			<div data-resize-track="left" className="ib-handle-track" />
			<div className="ib-handle-hit" style={style} onPointerDown={onPointerDown} />
		</div>
	);
}
