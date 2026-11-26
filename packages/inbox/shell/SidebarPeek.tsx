// Ported from the Workspaces app's SidebarPeek component and its
// useIsDesktopLg hook for the Inbox sidebar (the owner, 2026-10-09: the same
// component and motion). Port: the panel shows the Inbox's own navigation,
// handed in as `children` (Workspaces renders AppSidebarContent here);
// Tailwind classes became `ib-` classes in inbox.css; the hidden panel also
// turns `visibility: hidden` once its slide-out ends (inbox.css), so the page
// holds one visible navigation.

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

/**
 * A press that opens the peek (the project rail's ⋯, rail/PlaceRail.tsx): `n` counts the presses, `opener` is the
 * button. Opened this way it stays until a pick in it, a press outside it, Escape, the same button again, or the
 * pointer leaving it once it went in; then focus goes back to the button if it was in the peek.
 */
export interface PeekAsk {
	n: number;
	opener: HTMLElement | null;
}

export function SidebarPeek({ children, ask = null }: { children: ReactNode; ask?: PeekAsk | null }) {
	const { open } = useSidebar();
	const isLgDesktop = useIsDesktopLg();
	const [visible, setVisible] = useState(false);
	const panel = useRef<HTMLDivElement>(null);
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

	// A press on the rail's ⋯: open (focus into the peek), or close when it shows.
	const askedFor = useRef(0);
	const opener = ask?.opener ?? null;
	// Opened by the press (not by resting on the edge): the press's rules below apply until it hides.
	const [held, setHeld] = useState(false);
	if (!visible && held) setHeld(false);
	const visibleNow = useRef(visible);
	visibleNow.current = visible;
	useEffect(() => {
		if (!ask || ask.n === askedFor.current) return;
		askedFor.current = ask.n;
		clearShow();
		clearHide();
		if (visibleNow.current) setVisible(false);
		else {
			setVisible(true);
			setHeld(true);
		}
	}, [ask, clearShow, clearHide]);
	useEffect(() => {
		if (!held || !opener) return;
		panel.current?.querySelector<HTMLElement>("[data-inbox-nav]")?.focus({ preventScroll: true });
		const close = () => {
			setVisible(false);
			if (panel.current?.contains(document.activeElement)) opener.focus({ preventScroll: true });
		};
		// A menu or a dialog opened from a row in the peek lives outside it: a press there is not outside.
		const elsewhere = (target: EventTarget | null) =>
			target instanceof Element && !panel.current?.contains(target) && !opener.contains(target) && !target.closest('[role="menu"], [role="dialog"], [role="listbox"]');
		const onDown = (event: PointerEvent) => {
			if (elsewhere(event.target)) close();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || !panel.current?.contains(event.target as Node)) return;
			event.stopPropagation();
			close();
		};
		// A pick folds it away: a row or a page, never a section's fold, a sort or a menu's button.
		const onClick = (event: MouseEvent) => {
			const hit = event.target instanceof Element ? event.target.closest("button, a") : null;
			if (hit && !hit.matches("[aria-expanded], [aria-haspopup], [aria-pressed]")) setTimeout(close, 0);
		};
		const node = panel.current;
		document.addEventListener("pointerdown", onDown, true);
		window.addEventListener("keydown", onKey, true);
		node?.addEventListener("click", onClick);
		return () => {
			document.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("keydown", onKey, true);
			node?.removeEventListener("click", onClick);
		};
	}, [held, opener]);

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
				ref={panel}
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
