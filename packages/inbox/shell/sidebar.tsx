import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { useMotionValue } from "motion/react";
import type { MotionValue } from "motion/react";
import * as React from "react";

import { usePhone } from "../phone";
import { MotionStyleDiv, type MotionStyleValues } from "./motion-style-div";
import { preloadShellAnimate, useCombinedMotionValue, useShellProgress } from "./shell-motion";

const SIDEBAR_WIDTH = "232px";
const SIDEBAR_WIDTH_PX = 232;
const SIDEBAR_WIDTH_MOBILE = "260px";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

// The navigation becomes an off-canvas sheet only on a phone (packages/inbox/phone.ts:
// under 768 px wide, or a short touch screen, a phone in landscape). Read
// synchronously, so a phone never paints the docked sidebar first.
const useIsMobile = usePhone;

type SidebarContext = {
	state: "expanded" | "collapsed";
	open: boolean;
	setOpen: (open: boolean) => void;
	openMobile: boolean;
	setOpenMobile: (open: boolean) => void;
	isMobile: boolean;
	toggleSidebar: () => void;
	/** The ACCEPTED desktop width in px, as an element-scoped MotionValue.
	 * The live resize drag writes it per frame (never an inherited CSS custom
	 * property: that recalculates style for the whole tree every frame). */
	widthValue: MotionValue<number>;
	container: HTMLDivElement | null;
	toggleNotice: SidebarToggleNotice | null;
};

export type SidebarToggleNotice = { tone: "primary" | "neutral"; label: string };

const SidebarContext = React.createContext<SidebarContext | null>(null);

function renderMotionDiv(motionStyle: MotionStyleValues, staticStyle?: React.CSSProperties) {
	return function motionSurface(props: React.ComponentProps<"div">) {
		return (
			<MotionStyleDiv
				{...props}
				style={{ ...props.style, ...staticStyle }}
				motionStyle={motionStyle}
			/>
		);
	};
}

function isEditable(target: EventTarget | undefined): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
}

function useSidebar() {
	const context = React.useContext(SidebarContext);
	if (!context) {
		throw new Error("useSidebar must be used within a SidebarProvider.");
	}

	return context;
}

function SidebarProvider({
	defaultOpen = true,
	open: openProp,
	onOpenChange: setOpenProp,
	className,
	style,
	widthValue: widthValueProp,
	toggleNotice = null,
	children,
	...props
}: React.ComponentProps<"div"> & {
	toggleNotice?: SidebarToggleNotice | null;
	defaultOpen?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	widthValue?: MotionValue<number>;
}) {
	const isMobile = useIsMobile();
	const [openMobile, setOpenMobile] = React.useState(false);
	const [container, setContainer] = React.useState<HTMLDivElement | null>(null);
	const fallbackWidthValue = useMotionValue(SIDEBAR_WIDTH_PX);
	React.useEffect(() => {
		preloadShellAnimate();
	}, []);
	const widthValue = widthValueProp ?? fallbackWidthValue;

	const [_open, _setOpen] = React.useState(defaultOpen);
	const open = openProp ?? _open;
	const setOpen = React.useCallback(
		(value: boolean | ((value: boolean) => boolean)) => {
			const openState = typeof value === "function" ? value(open) : value;
			if (setOpenProp) {
				setOpenProp(openState);
			} else {
				_setOpen(openState);
			}
		},
		[setOpenProp, open],
	);

	const toggleSidebar = React.useCallback(() => {
		return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open);
	}, [isMobile, setOpen]);

	React.useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
				// Always ours: Firefox's Ctrl+B would open its bookmarks sidebar.
				event.preventDefault();
				if (isEditable(event.composedPath()[0])) return;
				toggleSidebar();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [toggleSidebar]);

	const state = open ? "expanded" : "collapsed";

	const contextValue = React.useMemo<SidebarContext>(
		() => ({
			state,
			open,
			setOpen,
			isMobile,
			openMobile,
			setOpenMobile,
			toggleSidebar,
			widthValue,
			container,
			toggleNotice,
		}),
		[state, open, setOpen, isMobile, openMobile, toggleSidebar, widthValue, container, toggleNotice],
	);

	return (
		<SidebarContext.Provider value={contextValue}>
			<div
				ref={setContainer}
				data-slot="sidebar-wrapper"
				style={
					{
						"--sidebar-width": SIDEBAR_WIDTH,
						...style,
					} as React.CSSProperties
				}
				className={className ? `ib-sb-wrapper ${className}` : "ib-sb-wrapper"}
				{...props}
			>
				{children}
			</div>
		</SidebarContext.Provider>
	);
}

function Sidebar({ className, children, ...props }: React.ComponentProps<"div">) {
	const { isMobile, state, openMobile, setOpenMobile, widthValue, container } = useSidebar();

	const desktopMotion = useShellProgress(state === "expanded");
	const desktopClamped = useCombinedMotionValue([desktopMotion.progress], ([value]) =>
		Math.min(1, Math.max(0, value)),
	);
	const allocation = useCombinedMotionValue([widthValue, desktopClamped], (latest) => {
		const [acceptedWidth, openProgress] = latest as [number, number];
		return acceptedWidth * openProgress;
	});

	const mobileMotion = useShellProgress(isMobile && openMobile);
	const mobileClamped = useCombinedMotionValue([mobileMotion.progress], ([value]) =>
		Math.min(1, Math.max(0, value)),
	);
	const mobileOffset = -8;
	const mobileX = useCombinedMotionValue(
		[mobileClamped],
		([value]) => mobileOffset + (0 - mobileOffset) * value,
	);

	// The closed sidebar deliberately stays MOUNTED (reversible animation),
	// so it leaves the tab order and accessibility tree once the close
	// SETTLES: `inert` does all three (tab order, SR tree, clicks). While open
	// or still animating, inert stays off so an interrupted close remains
	// fully interactive; on reopen it lifts immediately.
	const settledHidden = !desktopMotion.mounted;

	if (isMobile) {
		return (
			<SheetPrimitive.Root open={mobileMotion.mounted} onOpenChange={setOpenMobile}>
				<SheetPrimitive.Portal container={container}>
					<SheetPrimitive.Backdrop
						data-slot="sheet-overlay"
						render={renderMotionDiv({ opacity: mobileClamped })}
						className="ib-sb-scrim"
					/>
					<SheetPrimitive.Popup
						data-sidebar="sidebar"
						data-slot="sidebar"
						data-mobile="true"
						render={renderMotionDiv({ opacity: mobileClamped, x: mobileX }, {
							"--sidebar-width": SIDEBAR_WIDTH_MOBILE,
						} as React.CSSProperties)}
						className="ib-sb-sheet"
					>
						<SheetPrimitive.Title className="ib-sr">Sidebar</SheetPrimitive.Title>
						<div className="ib-sb-sheet-in">{children}</div>
					</SheetPrimitive.Popup>
				</SheetPrimitive.Portal>
			</SheetPrimitive.Root>
		);
	}

	return (
		<div
			className="ib-sb"
			data-state={state}
			data-collapsible={state === "collapsed" ? "offcanvas" : ""}
			data-slot="sidebar"
		>
			<MotionStyleDiv className="ib-sb-gap" motionStyle={{ width: allocation }} />
			<MotionStyleDiv
				inert={settledHidden}
				data-hidden={settledHidden ? "" : undefined}
				className={className ? `ib-sb-panel ${className}` : "ib-sb-panel"}
				motionStyle={{ width: allocation }}
				{...props}
			>
				<MotionStyleDiv
					data-sidebar="sidebar"
					className="ib-sb-inner"
					motionStyle={{ opacity: desktopClamped, width: widthValue }}
				>
					{children}
				</MotionStyleDiv>
			</MotionStyleDiv>
		</div>
	);
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<"button">) {
	const { toggleSidebar, toggleNotice, isMobile, open, openMobile } = useSidebar();
	const notice = toggleNotice && !(isMobile ? openMobile : open) ? toggleNotice : null;

	return (
		<button
			type="button"
			data-sidebar="trigger"
			data-slot="sidebar-trigger"
			className={className ? `ib-sb-trigger ${className}` : "ib-sb-trigger"}
			aria-label={notice ? `Toggle Sidebar, ${notice.label}` : "Toggle Sidebar"}
			data-notice={notice ? notice.tone : undefined}
			onClick={(event) => {
				onClick?.(event);
				toggleSidebar();
			}}
			{...props}
		>
			<PanelLeftIcon />
			{notice && <span className="ib-sb-trigger-dot" data-tone={notice.tone} aria-hidden="true" />}
		</button>
	);
}

function PanelLeftIcon(props: React.SVGProps<SVGSVGElement>) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden="true"
			{...props}
		>
			<path
				d="M2 12C2 8.31087 2 6.4663 2.81382 5.15877C3.1149 4.67502 3.48891 4.25427 3.91891 3.91554C5.08116 3 6.72077 3 10 3H14C17.2792 3 18.9188 3 20.0811 3.91554C20.5111 4.25427 20.8851 4.67502 21.1862 5.15877C22 6.4663 22 8.31087 22 12C22 15.6891 22 17.5337 21.1862 18.8412C20.8851 19.325 20.5111 19.7457 20.0811 20.0845C18.9188 21 17.2792 21 14 21H10C6.72077 21 5.08116 21 3.91891 20.0845C3.48891 19.7457 3.1149 19.325 2.81382 18.8412C2 17.5337 2 15.6891 2 12Z"
				stroke="currentColor"
				strokeWidth="2"
			/>
			<path d="M9.5 3L9.5 21" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
			<path
				d="M5 7H6M5 10H6"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
			/>
		</svg>
	);
}

export { Sidebar, SidebarProvider, SidebarTrigger, useSidebar };
