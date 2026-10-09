// Ported from Workspaces apps/web/src/components/ui/sidebar.tsx (cd4a9bfd1) for
// the Inbox sidebar (the owner, 2026-10-09: "use that same exact sidebar
// experience ... the same exact smooth animation"). What came across as is:
// the provider and its open/closed and mobile state, the ⌘/Ctrl+B toggle, the
// accepted-width MotionValue, the docked offcanvas motion (one spring on a
// progress value, allocation = width × progress on the spacer and the
// clipping panel, content held at full width with opacity on the same
// progress, inert once the close settles) and the mobile sheet on the same
// spring. What changed in the port:
// - Tailwind classes became `ib-` classes in inbox.css, in the Inbox's skin.
// - The provider does not read or write localStorage: the Inbox drives `open`
//   from its settings store (`inboxSidebarOpen`, cookie
//   `plannotator-inbox-sidebar-open`), as it does the Grid/Clean look.
// - Left out: the icon-mode and `none` collapsibles, the floating and inset
//   variants, the right side, SidebarRail and the menu, group and skeleton
//   parts (the Inbox draws its own rows), and the TooltipProvider.
// - The sheet portals into the provider's wrapper, so it keeps the Inbox's
//   tokens; Base UI's Dialog is used directly (Workspaces wraps it as Sheet).

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { useMotionValue } from "motion/react";
import type { MotionValue } from "motion/react";
import * as React from "react";

import { MotionStyleDiv, type MotionStyleValues } from "./motion-style-div";
import { preloadShellAnimate, useCombinedMotionValue, useShellProgress } from "./shell-motion";

// Fallback only: the Inbox shell always overrides --sidebar-width with its
// committed resizable value. This static twin exists for bare mounts.
const SIDEBAR_WIDTH = "232px";
const SIDEBAR_WIDTH_PX = 232;
const SIDEBAR_WIDTH_MOBILE = "260px";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

// The navigation becomes an off-canvas sheet only on phone widths.
const MOBILE_BREAKPOINT = 768;

function useIsMobile() {
	const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

	React.useEffect(() => {
		const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
		const onChange = () => {
			setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
		};
		mql.addEventListener("change", onChange);
		setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
		return () => mql.removeEventListener("change", onChange);
	}, []);

	return !!isMobile;
}

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
	/** The provider's wrapper, where the mobile sheet portals. */
	container: HTMLDivElement | null;
};

const SidebarContext = React.createContext<SidebarContext | null>(null);

/** Base UI render-prop adapter for MotionStyleDiv: the MotionValue styles
 * merge over Base UI's own style, as they did on `m.div`. */
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
	children,
	...props
}: React.ComponentProps<"div"> & {
	defaultOpen?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	/** Live accepted-width MotionValue (see SidebarContext.widthValue).
	 * Optional so bare mounts get the static twin. */
	widthValue?: MotionValue<number>;
}) {
	const isMobile = useIsMobile();
	const [openMobile, setOpenMobile] = React.useState(false);
	const [container, setContainer] = React.useState<HTMLDivElement | null>(null);
	const fallbackWidthValue = useMotionValue(SIDEBAR_WIDTH_PX);
	// Warm the open/close spring's chunk once the shell has painted.
	React.useEffect(() => {
		preloadShellAnimate();
	}, []);
	const widthValue = widthValueProp ?? fallbackWidthValue;

	// This is the internal state of the sidebar.
	// We use openProp and setOpenProp for control from outside the component.
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

	// Helper to toggle the sidebar.
	const toggleSidebar = React.useCallback(() => {
		return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open);
	}, [isMobile, setOpen]);

	// Adds a keyboard shortcut to toggle the sidebar.
	React.useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				toggleSidebar();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [toggleSidebar]);

	// We add a state so that we can do data-state="expanded" or "collapsed".
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
		}),
		[state, open, setOpen, isMobile, openMobile, toggleSidebar, widthValue, container],
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

	// THE sidebar's motion controllers (Workspaces motion contract). Two
	// surfaces, two controllers, ONE shared vocabulary (shellSpring via
	// useShellProgress): every entrypoint (SidebarTrigger, ⌘/Ctrl+B, the
	// collapse edge, the resize snap-close, click-collapse) flips the
	// provider's booleans; these hooks are the only thing that animates.
	//
	// Desktop docked: the accepted width lives in the context's element-
	// scoped `widthValue` MotionValue (the live resize drag writes it per
	// frame, render-free), so the animated allocation is width × progress
	// written to the elements' own styles: the drag flows through the
	// MotionValue at progress 1 with zero smoothing, while open/close
	// animates the multiplier.
	const desktopMotion = useShellProgress(state === "expanded");
	const desktopClamped = useCombinedMotionValue([desktopMotion.progress], ([value]) =>
		Math.min(1, Math.max(0, value)),
	);
	const allocation = useCombinedMotionValue([widthValue, desktopClamped], (latest) => {
		const [acceptedWidth, openProgress] = latest as [number, number];
		return acceptedWidth * openProgress;
	});

	// Mobile offcanvas: presence-style, opacity 0↔1 with x -8↔0 on the same
	// spring; the sheet stays mounted until progress zero.
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
		// Composed from the Dialog primitives so the ONE floating spring owns
		// the presentation. Base UI owns a11y: portal, modal focus trap, Esc
		// and backdrop dismiss (onOpenChange), aria wiring from the title.
		// The dialog's `open` is the controller's `mounted`, so the sheet
		// stays mounted through the exit spring and unmounts exactly at
		// progress zero (reduced motion: immediately).
		return (
			<SheetPrimitive.Root open={mobileMotion.mounted} onOpenChange={setOpenMobile}>
				<SheetPrimitive.Portal container={container}>
					{/* The scrim's fade rides the SAME progress as the panel. */}
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

	// Docked treatment: ONE animated allocation (accepted width × progress)
	// carried by BOTH the in-flow spacer (so the flex:1 main sibling reflows
	// continuously) and the fixed panel (which CLIPS). The inner content is
	// HELD at the accepted width with opacity riding the same progress: text
	// and icons never compress.
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
	const { toggleSidebar } = useSidebar();

	return (
		<button
			type="button"
			data-sidebar="trigger"
			data-slot="sidebar-trigger"
			className={className ? `ib-sb-trigger ${className}` : "ib-sb-trigger"}
			aria-label="Toggle Sidebar"
			onClick={(event) => {
				onClick?.(event);
				toggleSidebar();
			}}
			{...props}
		>
			<PanelLeftIcon />
		</button>
	);
}

/**
 * The sidebar-toggle glyph, from Workspaces
 * apps/web/src/components/icons/PanelLeftIcon.tsx (0219b4694), which copied it
 * from the Plannotator app sidebar reference.
 */
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
