import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { useMotionValue, type MotionValue } from "motion/react";

import { CollapsibleEdge, ResizeHandle } from "./CollapsibleEdge";
import { MotionStyleDiv } from "./motion-style-div";
import { Sidebar, SidebarProvider, useSidebar, type SidebarToggleNotice } from "./sidebar";
import { SidebarPeek } from "./SidebarPeek";
import { useResizablePanel } from "./useResizablePanel";

const SIDEBAR_DEFAULT = 232;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 520;

export function SidebarShell({
	open,
	onOpenChange,
	navigation,
	className,
	toggleNotice = null,
	children,
}: {
	open: boolean;
	toggleNotice?: SidebarToggleNotice | null;
	onOpenChange: (open: boolean) => void;
	navigation: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	const widthApplyRef = useRef<(width: number) => void>(() => {});
	const sidebarResize = useResizablePanel({
		storageKey: "plannotator-inbox-sidebar-width",
		defaultWidth: SIDEBAR_DEFAULT,
		minWidth: SIDEBAR_MIN,
		maxWidth: SIDEBAR_MAX,
		reserveViewport: 320,
		side: "left",
		snapCloseRatio: 0.5,
		onSnapClose: () => onOpenChange(false),
		onSnapOpen: () => onOpenChange(true),
		onClick: () => onOpenChange(false),
		apply: (w) => widthApplyRef.current(w),
	});
	const sidebarWidth = useMotionValue(sidebarResize.width);
	const panelId = useId();
	useEffect(() => {
		widthApplyRef.current = (w) => sidebarWidth.set(w);
	});
	useEffect(() => {
		sidebarWidth.set(sidebarResize.width);
	}, [sidebarWidth, sidebarResize.width]);

	return (
		<SidebarProvider
			open={open}
			onOpenChange={onOpenChange}
			widthValue={sidebarWidth}
			toggleNotice={toggleNotice}
			className={className}
			style={{ "--sidebar-width": `${sidebarResize.width}px` } as CSSProperties}
		>
			<Sidebar id={panelId}>{navigation}</Sidebar>
			<SidebarPeek>{navigation}</SidebarPeek>
			<SidebarEdge sidebarResize={sidebarResize} sidebarWidth={sidebarWidth} panelId={panelId} />
			{children}
		</SidebarProvider>
	);
}

function SidebarEdge({
	sidebarResize,
	sidebarWidth,
	panelId,
}: {
	sidebarResize: ReturnType<typeof useResizablePanel>;
	sidebarWidth: MotionValue<number>;
	panelId: string;
}) {
	const { open, setOpen, isMobile } = useSidebar();
	if (!open || isMobile) return null;
	return (
		<MotionStyleDiv className="ib-edge-pos" motionStyle={{ left: sidebarWidth }}>
			<CollapsibleEdge
				onCollapse={() => setOpen(false)}
				label="Sidebar width"
				controls={panelId}
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
