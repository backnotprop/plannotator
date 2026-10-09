// Ported from Workspaces apps/web/src/components/sidebar/SidebarPeek.tsx
// (499aaa1d9) and apps/web/src/hooks/useIsDesktopLg.ts (4459a16b8) for the
// Inbox sidebar (the owner, 2026-10-09: the same component and motion). Port:
// the panel shows the Inbox's own navigation, handed in as `children`
// (Workspaces renders AppSidebarContent here); Tailwind classes became `ib-`
// classes in inbox.css; the hidden panel also turns `visibility: hidden` once
// its slide-out ends (inbox.css), so the page holds one visible navigation.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useSidebar } from "./sidebar";

// Hover-intent: how long the cursor must rest on the left edge before the peek
// slides in. Keeps a quick brush past the edge from triggering it.
const SHOW_DELAY_MS = 600;
// Grace period before hiding when the cursor leaves the peek, so you don't lose
// it by cutting a corner.
const HIDE_DELAY_MS = 150;

/** Large screens only (>=1024px): the peek is a hover-intent affordance. */
const DESKTOP_LG_QUERY = "(min-width: 1024px)";

function useIsDesktopLg(): boolean {
	return useSyncExternalStore(subscribe, snapshot);
}

function subscribe(onChange: () => void): () => void {
	const mediaQuery = window.matchMedia(DESKTOP_LG_QUERY);
	mediaQuery.addEventListener("change", onChange);
	return () => mediaQuery.removeEventListener("change", onChange);
}

function snapshot(): boolean {
	return window.matchMedia(DESKTOP_LG_QUERY).matches;
}

export function SidebarPeek({ children }: { children: ReactNode }) {
	const { open } = useSidebar();
	const isLgDesktop = useIsDesktopLg();
	const [visible, setVisible] = useState(false);
	const showTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearShow = useCallback(() => {
		if (showTimeout.current) {
			clearTimeout(showTimeout.current);
			showTimeout.current = null;
		}
	}, []);

	const clearHide = useCallback(() => {
		if (hideTimeout.current) {
			clearTimeout(hideTimeout.current);
			hideTimeout.current = null;
		}
	}, []);

	// Edge strip: arm a delayed reveal (hover intent).
	const scheduleShow = useCallback(() => {
		clearHide();
		if (visible) return;
		clearShow();
		showTimeout.current = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
	}, [visible, clearHide, clearShow]);

	// Left the edge before the delay elapsed: cancel the pending reveal.
	const cancelShow = useCallback(() => {
		clearShow();
	}, [clearShow]);

	// On the peek itself: keep it open instantly (cancel any pending hide).
	const keepOpen = useCallback(() => {
		clearShow();
		clearHide();
		setVisible(true);
	}, [clearShow, clearHide]);

	const hide = useCallback(() => {
		clearShow();
		clearHide();
		hideTimeout.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
	}, [clearShow, clearHide]);

	// If the real sidebar opens, drop any pending peek state.
	useEffect(() => {
		if (open) {
			clearShow();
			clearHide();
			setVisible(false);
		}
	}, [open, clearShow, clearHide]);

	// Clean up timers on unmount.
	useEffect(
		() => () => {
			if (showTimeout.current) clearTimeout(showTimeout.current);
			if (hideTimeout.current) clearTimeout(hideTimeout.current);
		},
		[],
	);

	if (open || !isLgDesktop) return null;

	return (
		<>
			{/* Hover strip: invisible, full-height hit area on the left edge
			    with delayed reveal. */}
			<div
				data-sidebar-peek-strip
				className="ib-peek-strip"
				onMouseEnter={scheduleShow}
				onMouseLeave={cancelShow}
			/>
			{/* Full-height floating sidebar panel: 300ms enter easing; reduced
			    motion, direct final geometry. inert while hidden: the panel is a
			    full sidebar copy that stays MOUNTED offscreen. */}
			<div
				data-sidebar-peek
				data-visible={visible ? "" : undefined}
				inert={!visible}
				className="ib-peek"
				onMouseEnter={keepOpen}
				onMouseLeave={hide}
			>
				<div className="ib-peek-in">{children}</div>
			</div>
		</>
	);
}
