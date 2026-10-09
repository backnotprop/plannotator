// Copied from Workspaces apps/web/src/hooks/useResizablePanel.ts (a15a2839b) for
// the Inbox sidebar (the owner, 2026-10-09: the same component and motion).
// Port: the width persists through Plannotator's cookie storage instead of
// localStorage, as every Plannotator setting does (a session's port changes).

import { useCallback, useEffect, useRef, useState } from "react";
import { storage } from "@plannotator/ui/utils/storage";

interface UseResizablePanelOptions {
	storageKey: string;
	defaultWidth?: number;
	minWidth?: number;
	maxWidth?: number;
	side?: "left" | "right";
	/**
	 * Dragging the raw pointer target below `minWidth * snapCloseRatio` calls
	 * this IMMEDIATELY (mid-drag, not at pointer-up). When `onSnapOpen` is
	 * also provided the gesture stays alive afterward so the still-held
	 * pointer can reverse the close (design contract §3); without it the
	 * legacy terminal behavior is kept (gesture ends at the snap).
	 */
	onSnapClose?: () => void;
	/**
	 * The reversal path: fires when a still-held drag crosses back ABOVE the
	 * close threshold after a snap-close, so the consumer reopens the panel
	 * and width tracking resumes. Providing this is what opts a callsite into
	 * reversible (contract-shaped) dismissal.
	 */
	onSnapOpen?: () => void;
	/** Close threshold as a fraction of minWidth. Contract §3: 0.5. */
	snapCloseRatio?: number;
	apply?: (width: number) => void;
	/**
	 * Fires on pointer-up when the pointer never traveled past
	 * `clickThreshold` — a genuine click on the handle, not a drag. Mirrors
	 * @plannotator/ui's 0.26.0 `useResizablePanel` seam exactly (UX backlog
	 * #9: the whole handle is the click-to-collapse target): the hook owns
	 * the pointer state machine, so this is the only reliable click signal.
	 * Never fires on a snap-close or on `pointercancel` (aborted gestures).
	 * When it fires, the width is left untouched (not committed/persisted).
	 */
	onClick?: () => void;
	/** Max pointer travel (px) still counted as a click. Default 4 (upstream's). */
	clickThreshold?: number;
	/**
	 * When set, the live maximum is `min(maxWidth, innerWidth - reserveViewport)`
	 * so the panel can never squeeze the remaining content below this many px
	 * (contract §3: the sidebar preserves ≥320px of main content). Applied at
	 * restore, on every drag frame, and on keyboard resize; an idle window
	 * resize is re-clamped by the next interaction, not reactively.
	 */
	reserveViewport?: number;
}

export interface ResizeHandleProps {
	isDragging: boolean;
	onPointerDown: (e: React.PointerEvent) => void;
	style: React.CSSProperties;
}

function getStoredWidth(storageKey: string, minWidth: number, maxWidth: number) {
	const saved = storage.getItem(storageKey);
	if (!saved) return undefined;
	const n = Number(saved);
	// Clamp finite out-of-range values instead of rejecting (contract §3:
	// "clamp on every restore") — a width persisted under an older viable
	// range (e.g. the pre-polish 220 minimum) restores to the nearest viable
	// width, not the default. Non-finite garbage still falls to the default.
	if (!Number.isFinite(n)) return undefined;
	return Math.min(maxWidth, Math.max(minWidth, n));
}

export function useResizablePanel({
	storageKey,
	defaultWidth = 288,
	minWidth = 200,
	maxWidth = 600,
	side = "right",
	onSnapClose,
	onSnapOpen,
	snapCloseRatio = 0.5,
	apply,
	onClick,
	clickThreshold = 4,
	reserveViewport,
}: UseResizablePanelOptions) {
	// The live maximum: static unless reserveViewport asks for the
	// main-content floor. Computed at call time (never memoized) so a drag
	// after a window resize clamps against the current viewport.
	const effectiveMax = useCallback(
		() =>
			reserveViewport === undefined
				? maxWidth
				: Math.max(minWidth, Math.min(maxWidth, window.innerWidth - reserveViewport)),
		[maxWidth, minWidth, reserveViewport],
	);

	const [width, setWidth] = useState(
		() => getStoredWidth(storageKey, minWidth, effectiveMax()) ?? defaultWidth,
	);
	const [isDragging, setIsDragging] = useState(false);

	// The ANNOUNCED maximum tracks the operable one (contract §3: correct
	// aria-valuemax): with reserveViewport, drag and keyboard clamp to
	// min(maxWidth, innerWidth - reserve), so the separator must announce
	// that same bound — a static 520 on a 700px window would promise a range
	// End cannot reach. Recomputed on window resize; without reserveViewport
	// the design max is already the operable max and no listener mounts.
	const [liveMax, setLiveMax] = useState(effectiveMax);
	useEffect(() => {
		if (reserveViewport === undefined) return;
		const onResize = () => setLiveMax(effectiveMax());
		onResize();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [effectiveMax, reserveViewport]);

	const widthRef = useRef(width);
	const startXRef = useRef(0);
	const startWidthRef = useRef(0);
	const draggingRef = useRef(false);
	// True while THIS gesture has snap-closed the panel and not yet reversed.
	const closedRef = useRef(false);
	// Latches true once the pointer travels past clickThreshold —
	// distinguishes a click from a drag. Reset on each pointerdown.
	const movedRef = useRef(false);
	const latestXRef = useRef(0);
	const rafRef = useRef<number | null>(null);

	// Latest-refs via effect, NOT render-time writes: the React Compiler
	// treats a ref mutated during render as a rules violation and bails out
	// of compiling every consumer of this hook (the heaviest shell surfaces).
	// The refs are only read inside pointer/keyboard handlers, which always
	// run after the effect has stamped the latest values.
	const applyRef = useRef(apply);
	const onSnapCloseRef = useRef(onSnapClose);
	const onSnapOpenRef = useRef(onSnapOpen);
	const onClickRef = useRef(onClick);
	useEffect(() => {
		applyRef.current = apply;
		onSnapCloseRef.current = onSnapClose;
		onSnapOpenRef.current = onSnapOpen;
		onClickRef.current = onClick;
	});

	const flush = useCallback(() => {
		rafRef.current = null;
		if (!draggingRef.current) return;
		const delta =
			side === "right"
				? startXRef.current - latestXRef.current
				: latestXRef.current - startXRef.current;
		const raw = startWidthRef.current + delta;
		const closeThreshold = minWidth * snapCloseRatio;

		if (onSnapCloseRef.current) {
			if (!closedRef.current && raw < closeThreshold) {
				// Below the dismiss threshold: close NOW, mid-drag (contract §3 —
				// never wait for pointer-up). Width state stays at the pre-drag
				// value so a reversal (or the next open) lands somewhere sane.
				widthRef.current = startWidthRef.current;
				applyRef.current?.(startWidthRef.current);
				setWidth(startWidthRef.current);
				if (onSnapOpenRef.current) {
					// Reversible close: the gesture stays alive so crossing back
					// above the threshold reopens before release.
					closedRef.current = true;
					onSnapCloseRef.current();
					return;
				}
				// Legacy terminal close (no reversal wired): end the gesture.
				draggingRef.current = false;
				setIsDragging(false);
				onSnapCloseRef.current();
				return;
			}
			if (closedRef.current) {
				if (raw < closeThreshold) return; // still below — stay closed
				// Reversal: the held pointer crossed back — reopen and resume
				// tracking from the live raw target.
				closedRef.current = false;
				onSnapOpenRef.current?.();
			}
		}

		const w = Math.min(effectiveMax(), Math.max(minWidth, raw));
		widthRef.current = w;
		if (applyRef.current) applyRef.current(w);
		else setWidth(w);
	}, [side, minWidth, snapCloseRatio, effectiveMax]);

	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			if (e.button !== 0) return;
			e.preventDefault();
			startXRef.current = e.clientX;
			startWidthRef.current = widthRef.current;
			latestXRef.current = e.clientX;
			closedRef.current = false;
			movedRef.current = false;
			draggingRef.current = true;
			setIsDragging(true);

			const onMove = (ev: PointerEvent) => {
				if (!draggingRef.current) return;
				latestXRef.current = ev.clientX;
				if (Math.abs(latestXRef.current - startXRef.current) > clickThreshold)
					movedRef.current = true;
				if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush);
			};
			const cleanup = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				window.removeEventListener("pointercancel", onUp);
			};
			function onUp(ev: PointerEvent) {
				// pointercancel = the browser aborted the gesture (palm
				// rejection, a system gesture, focus loss). It is NOT a
				// completed click — only clean up drag state, never collapse.
				const cancelled = ev.type === "pointercancel";
				// Released (or aborted) while snap-closed: the close already
				// happened and stands; never persist a below-threshold width
				// (contract §3) and never double-fire collapse via onClick.
				const endedClosed = closedRef.current;
				draggingRef.current = false;
				closedRef.current = false;
				if (rafRef.current != null) {
					cancelAnimationFrame(rafRef.current);
					rafRef.current = null;
				}
				setIsDragging(false);
				if (!endedClosed) {
					if (onClickRef.current && !movedRef.current && !cancelled) {
						// A pointerdown+up that never crossed the threshold is a
						// click, not a resize — fire onClick (collapse) and leave
						// the width untouched. Mirrors the package hook (0.26.0).
						onClickRef.current();
					} else {
						// widthRef is always clamped ≥ minWidth here, so only
						// accepted widths ever reach storage.
						setWidth(widthRef.current);
						storage.setItem(storageKey, String(widthRef.current));
					}
				}
				cleanup();
			}

			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			window.addEventListener("pointercancel", onUp);
		},
		[flush, storageKey, clickThreshold],
	);

	/**
	 * Keyboard/imperative resize (contract §3 separator behavior): clamps to
	 * the viable range — the pointer-only dismissal threshold NEVER applies
	 * here — applies, commits, and persists in one step.
	 */
	const resizeTo = useCallback(
		(px: number) => {
			const w = Math.min(effectiveMax(), Math.max(minWidth, px));
			widthRef.current = w;
			applyRef.current?.(w);
			setWidth(w);
			storage.setItem(storageKey, String(w));
		},
		[effectiveMax, minWidth, storageKey],
	);

	// No double-click handler on purpose (UX backlog #9): the old
	// onDoubleClick auto-fit (resetWidth) is retired everywhere — double-click
	// on an edge does nothing.
	return {
		width,
		isDragging,
		resizeTo,
		/** Viable range for aria-valuemin/max on the separator. maxWidth is
		 * the OPERABLE max (viewport-aware when reserveViewport is set), so
		 * the announced range is always reachable. */
		minWidth,
		maxWidth: liveMax,
		handleProps: {
			isDragging,
			onPointerDown,
			style: { touchAction: "none" },
		} as ResizeHandleProps,
	};
}
