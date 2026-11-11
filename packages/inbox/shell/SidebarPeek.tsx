import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useSidebar } from "./sidebar";

const SHOW_DELAY_MS = 600;
const HIDE_DELAY_MS = 150;

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

	const scheduleShow = useCallback(() => {
		clearHide();
		if (visible) return;
		clearShow();
		showTimeout.current = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
	}, [visible, clearHide, clearShow]);

	const cancelShow = useCallback(() => {
		clearShow();
	}, [clearShow]);

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

	useEffect(() => {
		if (open) {
			clearShow();
			clearHide();
			setVisible(false);
		}
	}, [open, clearShow, clearHide]);

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
