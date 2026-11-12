import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { storage } from "@plannotator/ui/utils/storage";

interface UseResizablePanelOptions {
	storageKey: string;
	defaultWidth?: number;
	minWidth?: number;
	maxWidth?: number;
	side?: "left" | "right";
	onSnapClose?: () => void;
	onSnapOpen?: () => void;
	snapCloseRatio?: number;
	apply?: (width: number) => void;
	onClick?: () => void;
	clickThreshold?: number;
	reserveViewport?: number;
	container?: () => HTMLElement | null | undefined;
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
	container,
}: UseResizablePanelOptions) {
	const effectiveMax = useCallback(() => {
		if (reserveViewport === undefined) return maxWidth;
		const room = container?.()?.clientWidth || window.innerWidth;
		return Math.max(minWidth, Math.min(maxWidth, room - reserveViewport));
	}, [maxWidth, minWidth, reserveViewport, container]);

	const [width, setWidth] = useState(
		() => getStoredWidth(storageKey, minWidth, container ? maxWidth : effectiveMax()) ?? defaultWidth,
	);
	const [isDragging, setIsDragging] = useState(false);

	const [liveMax, setLiveMax] = useState(effectiveMax);
	useLayoutEffect(() => {
		if (reserveViewport === undefined) return;
		const onResize = () => setLiveMax(effectiveMax());
		onResize();
		window.addEventListener("resize", onResize);
		const el = container?.();
		const observer = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
		if (el) observer?.observe(el);
		return () => {
			window.removeEventListener("resize", onResize);
			observer?.disconnect();
		};
	}, [effectiveMax, reserveViewport, container]);

	const widthRef = useRef(width);
	const startXRef = useRef(0);
	const startWidthRef = useRef(0);
	const preDragWidthRef = useRef(0);
	const draggingRef = useRef(false);
	const closedRef = useRef(false);
	const movedRef = useRef(false);
	const latestXRef = useRef(0);
	const rafRef = useRef<number | null>(null);

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
				widthRef.current = startWidthRef.current;
				applyRef.current?.(startWidthRef.current);
				setWidth(startWidthRef.current);
				if (onSnapOpenRef.current) {
					closedRef.current = true;
					onSnapCloseRef.current();
					return;
				}
				draggingRef.current = false;
				setIsDragging(false);
				onSnapCloseRef.current();
				return;
			}
			if (closedRef.current) {
				if (raw < closeThreshold) return;
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
			preDragWidthRef.current = widthRef.current;
			startWidthRef.current = Math.min(effectiveMax(), widthRef.current);
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
				const cancelled = ev.type === "pointercancel";
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
						widthRef.current = preDragWidthRef.current;
						applyRef.current?.(startWidthRef.current);
						setWidth(widthRef.current);
						onClickRef.current();
					} else if (widthRef.current === startWidthRef.current) {
						widthRef.current = preDragWidthRef.current;
						applyRef.current?.(startWidthRef.current);
						setWidth(widthRef.current);
					} else {
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
		[flush, storageKey, clickThreshold, effectiveMax],
	);

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

	return {
		width,
		isDragging,
		resizeTo,
		minWidth,
		maxWidth: liveMax,
		handleProps: {
			isDragging,
			onPointerDown,
			style: { touchAction: "none" },
		} as ResizeHandleProps,
	};
}
