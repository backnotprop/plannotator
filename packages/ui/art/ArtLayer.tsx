// One art layer per ground that may carry art (Workspaces SPEC-desktop-art-
// backgrounds-2026-10-01 section 2). In Workspaces: the Inbox list's scroller
// (the home), the workspace lists' scroll ground, the Settings frame, the
// desktop first run, and the document read surface. In the Plannotator Inbox:
// the window's main area, around the list, the thread and Settings. Each
// ground carries `isolation: isolate`. Mounted as the ground's FIRST child,
// with the canvas under every child (`z-index` below zero inside the ground's
// own stacking context) and `pointer-events: none`, `aria-hidden`:
//
// - `ground="scroll"` (the default): the ground is the scroller. The host is
//   a zero-height sticky box pinned to the top of the ground's visible box.
// - `ground="frame"`: the ground does not scroll; scrollers inside it do. The
//   host is absolute over the ground's padding box (the ground is positioned),
//   so it takes no room in a flex or grid ground; a scroll anywhere inside and
//   a row added or removed anywhere inside count as a change.
//
// It is an allowlist of grounds: the Browser and Live Maps mount none, and
// the path guard below holds even if one of these grounds ever renders there.
//
// Main-thread work after mount is only this: on a resize, a content change
// or a scroll, fade the canvas out, wait 150 ms for quiet, collect the keep
// rectangles in idle chunks, post them, and fade back in when the worker has
// drawn the new layout. Art is never under a moving word.

import { useEffect, useRef, type CSSProperties } from "react";

import { useArtBackground, type ArtBackgroundApi } from "./art-context";
import { collectRects } from "./collect-rects";

/** Routes that host native content: never a layer, whatever the ground. */
const NO_ART_PATHS = ["/browser"];
const QUIET_MS = 150;

export function artAllowedAt(pathname: string): boolean {
	return !NO_ART_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export type ArtGround = "scroll" | "frame";

export interface ArtLayerProps {
	readonly ground?: ArtGround;
	/**
	 * The layer gives its ground `isolation: isolate` (and, for a frame that is
	 * not positioned, `position: relative`) while it is mounted, and puts the
	 * ground's own values back when it goes. For a host whose grounds do not
	 * carry those styles themselves, so a ground with no art is untouched.
	 */
	readonly isolateGround?: boolean;
}

export function ArtLayer({ ground = "scroll", isolateGround = false }: ArtLayerProps = {}) {
	const art = useArtBackground();
	if (art === null || art.theme === "none" || !artAllowedAt(window.location.pathname))
		return null;
	return <ArtLayerHost art={art} frame={ground === "frame"} isolate={isolateGround} />;
}

// Inline styles, not utility classes, so a host's CSS build need not scan
// this package. The values are the Tailwind classes Workspaces drew with.
const CANVAS_STYLE: Partial<CSSStyleDeclaration> = {
	pointerEvents: "none",
	position: "absolute",
	top: "0",
	left: "0",
	opacity: "0",
	transitionProperty: "opacity",
	transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
	transitionDuration: "150ms",
};

const SCROLL_HOST_STYLE: CSSProperties = {
	pointerEvents: "none",
	position: "sticky",
	top: 0,
	left: 0,
	zIndex: -10,
	height: 0,
	width: "100%",
};

const FRAME_HOST_STYLE: CSSProperties = {
	pointerEvents: "none",
	position: "absolute",
	inset: 0,
	zIndex: -10,
	overflow: "hidden",
};

function ArtLayerHost({
	art,
	frame,
	isolate,
}: {
	art: ArtBackgroundApi;
	frame: boolean;
	isolate: boolean;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const artRef = useRef(art);
	useEffect(() => {
		artRef.current = art;
	});
	const pixelated = art.pixelated;
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	useEffect(() => {
		if (canvasRef.current !== null)
			canvasRef.current.style.imageRendering = pixelated ? "pixelated" : "auto";
	}, [pixelated]);

	useEffect(() => {
		const host = hostRef.current;
		const ground = host?.parentElement;
		if (host === null || ground === null || ground === undefined) return;
		const kept = { isolation: ground.style.isolation, position: ground.style.position };
		if (isolate) {
			ground.style.isolation = "isolate";
			const position = getComputedStyle(ground).position;
			// "" where no stylesheet applies (a test DOM): the initial value, static.
			if (frame && (position === "static" || position === "")) ground.style.position = "relative";
		}
		// The canvas is made here, not rendered: a transferred canvas cannot be
		// handed over twice, and each mount needs its own.
		const canvas = document.createElement("canvas");
		canvas.setAttribute("data-art-layer", "");
		canvas.setAttribute("aria-hidden", "true");
		Object.assign(canvas.style, CANVAS_STYLE);
		canvas.style.imageRendering = artRef.current.pixelated ? "pixelated" : "auto";
		host.appendChild(canvas);
		canvasRef.current = canvas;
		let pending: number | null = null;
		let cancelCollect: (() => void) | null = null;
		const id = artRef.current.mount(canvas, () => {
			if (pending === null && cancelCollect === null) canvas.style.opacity = "1";
		});

		const collect = () => {
			pending = null;
			const w = ground.clientWidth;
			const h = ground.clientHeight;
			canvas.style.width = `${w}px`;
			canvas.style.height = `${h}px`;
			cancelCollect?.();
			cancelCollect = collectRects(ground, host, ({ rects, active }) => {
				cancelCollect = null;
				artRef.current.layout(id, {
					w,
					h,
					dpr: window.devicePixelRatio || 1,
					rects,
					active,
				});
			});
		};
		const changed = () => {
			canvas.style.opacity = "0";
			if (pending !== null) window.clearTimeout(pending);
			pending = window.setTimeout(collect, QUIET_MS);
		};

		const observer = typeof ResizeObserver === "function" ? new ResizeObserver(changed) : null;
		const observeChildren = () => {
			if (observer === null) return;
			observer.observe(ground);
			for (const child of ground.children) if (child !== host) observer.observe(child);
		};
		observeChildren();
		const children = new MutationObserver(() => {
			observer?.disconnect();
			observeChildren();
			changed();
		});
		// A frame's rows live in scrollers inside it: any row added or removed
		// below, and any scroll below (scroll does not bubble; capture sees it).
		children.observe(ground, { childList: true, subtree: frame });
		const scrollOptions = { passive: true, capture: frame } as const;
		ground.addEventListener("scroll", changed, scrollOptions);
		const dprQuery =
			typeof window.matchMedia === "function"
				? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
				: null;
		dprQuery?.addEventListener("change", changed);
		collect();

		return () => {
			if (pending !== null) window.clearTimeout(pending);
			cancelCollect?.();
			observer?.disconnect();
			children.disconnect();
			ground.removeEventListener("scroll", changed, scrollOptions);
			dprQuery?.removeEventListener("change", changed);
			artRef.current.unmount(id);
			canvas.remove();
			canvasRef.current = null;
			if (isolate) {
				ground.style.isolation = kept.isolation;
				ground.style.position = kept.position;
			}
		};
	}, [frame, isolate]);

	return (
		<div
			ref={hostRef}
			aria-hidden="true"
			data-art-host={frame ? "frame" : "scroll"}
			style={frame ? FRAME_HOST_STYLE : SCROLL_HOST_STYLE}
		/>
	);
}
