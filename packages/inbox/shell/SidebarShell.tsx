// Ported from the sidebar half of Workspaces apps/web/src/app/AppShell.tsx
// (e2c77711d) for the Inbox (the owner, 2026-10-09: the same component and
// motion): the resizable width as an element-scoped MotionValue, the
// reversible resize-to-dismiss, click-to-collapse on the edge, the peek, and
// `--sidebar-width` as the committed at-rest width. Port: the open state is
// the Inbox's (`open` / `onOpenChange`, from its settings store), so the
// snap-close and the edge click call `onOpenChange` directly instead of
// Workspaces' close and open refs; the width range is the Inbox's (232 px is
// the record's width; Workspaces runs 275 in 240 to 520); the page frame,
// search, assistant and the rest of AppShell stay in Workspaces.

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { useMotionValue, type MotionValue } from "motion/react";

import { CollapsibleEdge, ResizeHandle } from "./CollapsibleEdge";
import { MotionStyleDiv } from "./motion-style-div";
import { Sidebar, SidebarProvider, useSidebar } from "./sidebar";
import { SidebarPeek } from "./SidebarPeek";
import { useResizablePanel } from "./useResizablePanel";

// The record draws the sidebar at 232 px. The viable range keeps the record's
// width inside it; reserveViewport keeps 320 px of the page beside it, as in
// Workspaces.
const SIDEBAR_DEFAULT = 232;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 520;

export function SidebarShell({
	open,
	onOpenChange,
	navigation,
	className,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The sidebar's contents, drawn docked, in the peek and in the phone sheet. */
	navigation: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	// Latest-ref via effect, read only by the hook's pointer handlers.
	const widthApplyRef = useRef<(width: number) => void>(() => {});
	const sidebarResize = useResizablePanel({
		storageKey: "plannotator-inbox-sidebar-width",
		defaultWidth: SIDEBAR_DEFAULT,
		minWidth: SIDEBAR_MIN,
		maxWidth: SIDEBAR_MAX,
		reserveViewport: 320,
		side: "left",
		// Reversible resize-to-dismiss: below min×0.5 the sidebar closes
		// mid-drag; crossing back reopens under the held pointer.
		snapCloseRatio: 0.5,
		onSnapClose: () => onOpenChange(false),
		onSnapOpen: () => onOpenChange(true),
		// Threshold-gated (4px): a click on the handle collapses the sidebar;
		// a drag resizes it.
		onClick: () => onOpenChange(false),
		// Render-free drag frames land on the element-scoped MotionValue.
		apply: (w) => widthApplyRef.current(w),
	});
	const sidebarWidth = useMotionValue(sidebarResize.width);
	useEffect(() => {
		widthApplyRef.current = (w) => sidebarWidth.set(w);
	});
	// Committed-width sync (release commits, keyboard resizeTo, restores).
	useEffect(() => {
		sidebarWidth.set(sidebarResize.width);
	}, [sidebarWidth, sidebarResize.width]);

	return (
		<SidebarProvider
			open={open}
			onOpenChange={onOpenChange}
			widthValue={sidebarWidth}
			className={className}
			style={{ "--sidebar-width": `${sidebarResize.width}px` } as CSSProperties}
		>
			<Sidebar>{navigation}</Sidebar>
			<SidebarPeek>{navigation}</SidebarPeek>
			<SidebarEdge sidebarResize={sidebarResize} sidebarWidth={sidebarWidth} />
			{children}
		</SidebarProvider>
	);
}

function SidebarEdge({
	sidebarResize,
	sidebarWidth,
}: {
	sidebarResize: ReturnType<typeof useResizablePanel>;
	sidebarWidth: MotionValue<number>;
}) {
	const { open, setOpen, isMobile } = useSidebar();
	if (!open || isMobile) return null;
	return (
		// The edge rides the same element-scoped width MotionValue as the
		// sidebar geometry: a drag frame moves it without touching any
		// inherited CSS custom property.
		<MotionStyleDiv className="ib-edge-pos" motionStyle={{ left: sidebarWidth }}>
			<CollapsibleEdge
				onCollapse={() => setOpen(false)}
				label="Sidebar width"
				isDragging={sidebarResize.isDragging}
				resize={{
					value: sidebarResize.width,
					min: sidebarResize.minWidth,
					max: sidebarResize.maxWidth,
					resizeTo: sidebarResize.resizeTo,
				}}
			>
				<ResizeHandle {...sidebarResize.handleProps} />
			</CollapsibleEdge>
		</MotionStyleDiv>
	);
}
