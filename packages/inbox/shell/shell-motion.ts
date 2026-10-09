// Copied from Workspaces apps/web/src/lib/shell-motion.ts (cd4a9bfd1) for the
// Inbox sidebar (the owner, 2026-10-09: the same component and motion). Port:
// imports from `motion/react` (the same framer-motion 12.43.0); the document
// rail's `useRailMotion` is left out (the Inbox has no rail).

import { useEffect, useLayoutEffect, useState } from "react";

// The MotionValue core and the frame loop only. framer's `animate` rides its
// own chunk (lib/shell-animate.ts, loaded once the shell mounts, and on
// demand) and its
// `useTransform` (which pulls the interpolate and colour mixers even for a
// function transform) is replaced by `useCombinedMotionValue` below: the
// shell paints at rest, so neither belongs on the boot path.
import { cancelFrame, frame, useMotionValue, type MotionValue } from "motion/react";

import type { ShellAnimate } from "./shell-animate";

let shellAnimate: ShellAnimate | null = null;
let shellAnimateLoad: Promise<ShellAnimate> | null = null;

/** Load the shell spring's animator once per session. A failed fetch clears
 * the memo so the next toggle retries. */
export function loadShellAnimate(): Promise<ShellAnimate> {
	shellAnimateLoad ??= import("./shell-animate").then(
		(module) => {
			shellAnimate = module.animate;
			return module.animate;
		},
		(error: unknown) => {
			shellAnimateLoad = null;
			throw error;
		},
	);
	return shellAnimateLoad;
}

/** Warm the animator from the sidebar provider's mount effect, which runs
 * once the shell has committed, so the first open or close finds it loaded.
 * Not at idle: a boot that stays busy (the home's own chunks and reads)
 * would push an idle callback past the first click. */
export function preloadShellAnimate(): void {
	if (shellAnimate === null) void loadShellAnimate().catch(() => {});
}

/**
 * framer's `useTransform([values], fn)`, same semantics: the combined value
 * is computed synchronously during render and, after mount, recomputed on
 * the frame loop's preRender step whenever an input changes (so the render
 * step that writes styles reads the fresh value). Written here because
 * framer's hook module statically pulls its range interpolator and colour
 * mixers, which the shell never uses.
 */
export function useCombinedMotionValue<T>(
	values: readonly MotionValue<number>[],
	combine: (latest: number[]) => T,
): MotionValue<T> {
	const read = () => combine(values.map((value) => value.get()));
	const combined = useMotionValue<T>(read());
	const update = () => combined.set(read());
	update();
	useLayoutEffect(() => {
		const schedule = () => frame.preRender(update, false, true);
		const subscriptions = values.map((value) => value.on("change", schedule));
		return () => {
			for (const unsubscribe of subscriptions) unsubscribe();
			cancelFrame(update);
		};
	});
	return combined;
}

/**
 * The ONE shared shell spring (motion contract): every coordinated
 * shell-geometry transition (rail open/close today) uses this exact spring.
 * Never give a shell surface its own duration/easing.
 */
export const shellSpring = {
	type: "spring",
	duration: 0.5,
	bounce: 0.1,
} as const;

/** Live prefers-reduced-motion, read per mount and subscribed for changes.
 * The app has no separate motion preference beyond the media query (the
 * landing's MotionConfig is page-scoped); if one ever exists it must feed
 * the same controller, not grow a second reduced path. */
export function usePrefersReducedMotion(): boolean {
	const [reduced, setReduced] = useState(
		() =>
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const onChange = () => setReduced(query.matches);
		// Older WebKit shims lack addEventListener on MediaQueryList.
		query.addEventListener?.("change", onChange);
		return () => query.removeEventListener?.("change", onChange);
	}, []);
	return reduced;
}

export interface ShellProgress {
	/** Open progress 0↔1 — the one authoritative animation value. */
	progress: MotionValue<number>;
	/** True while logically open OR progress > 0; flips false only when the
	 * close spring reaches zero (the unmount/inert bookkeeping moment). */
	mounted: boolean;
}

/**
 * THE shell open/close motion controller (motion contract, owner complaint
 * 2026-07-27: programmatic toggles "just immediately jumping"). One per
 * shell surface (document rail, app sidebar, mobile sheet). EVERY entrypoint
 * for a surface — trigger buttons, keyboard shortcut, collapse edge,
 * snap-close, click-collapse, auto-yield suppression, late-arriving host
 * defaults — flips the surface's ONE `open` boolean upstream; this hook is
 * the only thing that animates:
 *
 * 1. stop the active spring WITHOUT resetting its value;
 * 2. animate the existing progress from its CURRENT value to 1/0 with the
 *    shared shellSpring (interruptions reverse mid-flight, never restart
 *    from an endpoint);
 * 3. under reduced motion, set the target directly and still complete the
 *    unmount bookkeeping;
 * 4. no React rerender per animation frame — geometry rides MotionValues;
 *    the only state is the at-zero `mounted` flip.
 */
export function useShellProgress(open: boolean): ShellProgress {
	const reducedMotion = usePrefersReducedMotion();
	const progress = useMotionValue(open ? 1 : 0);
	const [mounted, setMounted] = useState(open);

	useEffect(() => {
		progress.stop();
		const target = open ? 1 : 0;
		if (open) setMounted(true);
		if (reducedMotion) {
			progress.set(target);
			if (!open) setMounted(false);
			return;
		}
		if (progress.get() === target) {
			// Already settled (initial mount, or a redundant flip): no travel,
			// but the close bookkeeping must still complete.
			if (!open) setMounted(false);
			return;
		}
		let controls: { stop: () => void } | null = null;
		let cancelled = false;
		const start = (animate: ShellAnimate) => {
			if (cancelled) return;
			controls = animate(progress, target, {
				...shellSpring,
				onComplete: () => {
					if (!open) setMounted(false);
				},
			});
		};
		// The animator is loaded once the shell mounts, so this is the
		// synchronous path; a toggle that beats that load waits for the one
		// chunk fetch and then springs from the current progress.
		if (shellAnimate !== null) start(shellAnimate);
		else
			void loadShellAnimate().then(start, () => {
				// The chunk did not load: land on the target the way reduced
				// motion does, so the close bookkeeping still completes.
				if (cancelled) return;
				progress.set(target);
				if (!open) setMounted(false);
			});
		// Interruption path: a new toggle (or unmount) stops the spring in
		// place; the next run animates from wherever progress is now.
		return () => {
			cancelled = true;
			controls?.stop();
		};
	}, [open, reducedMotion, progress]);

	return { progress, mounted };
}
