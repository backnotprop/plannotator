// The art backgrounds' provider (Workspaces SPEC-desktop-art-backgrounds-
// 2026-10-01 section 3). The host hands it the person's choice, the colour
// mode and a way to start the art worker; the provider reads Reduce motion
// and page visibility itself, and owns the one art worker. The worker is
// created only when a background is chosen and a ground mounts a layer, after
// first paint, and terminated when the choice goes back to None.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ArtBackgroundContext, type ArtBackgroundApi } from "./art-context";
import { ART_DEFAULT_ASSETS } from "./assets";
import type { ArtAssets, ArtLayout, FromArtWorker, ToArtWorker } from "./protocol";
import type { ArtCityId, ArtThemeId } from "./vocabulary";

/**
 * Starts the art worker on `art.worker.ts`. How depends on the host's bundler:
 * `new Worker(new URL("@plannotator/ui/art/art.worker.ts", import.meta.url), { type: "module" })`
 * for a chunked build, a Vite `?worker&inline` import for a single-file page.
 * A promise lets the host load that import lazily.
 */
export type ArtWorkerFactory = () => Worker | Promise<Worker>;

const REDUCE_MOTION = "(prefers-reduced-motion: reduce)";

/** The browser can run the engine: a worker that draws to a transferred canvas. */
export function artEngineSupported(): boolean {
	return (
		typeof Worker === "function" &&
		typeof OffscreenCanvas === "function" &&
		typeof HTMLCanvasElement !== "undefined" &&
		"transferControlToOffscreen" in HTMLCanvasElement.prototype
	);
}

export function useReducedMotion(): boolean {
	const [reduce, setReduce] = useState(
		() => typeof window.matchMedia === "function" && window.matchMedia(REDUCE_MOTION).matches,
	);
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const query = window.matchMedia(REDUCE_MOTION);
		const onChange = () => setReduce(query.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);
	return reduce;
}

interface Queued {
	readonly msg: ToArtWorker;
	readonly transfer: Transferable[];
}

export interface ArtBackgroundProviderProps {
	readonly theme: ArtThemeId;
	readonly city: ArtCityId;
	/** The colour mode on screen. */
	readonly dark: boolean;
	readonly createWorker: ArtWorkerFactory;
	/** Totman and the Drafting font; the package's own copies by default. */
	readonly assets?: ArtAssets;
	readonly children: ReactNode;
}

export function ArtBackgroundProvider({
	theme,
	city,
	dark,
	createWorker,
	assets = ART_DEFAULT_ASSETS,
	children,
}: ArtBackgroundProviderProps) {
	const reduce = useReducedMotion();
	const workerRef = useRef<Worker | null>(null);
	/** A worker on its way (an async factory); its messages wait in `queueRef`. */
	const startingRef = useRef(false);
	const queueRef = useRef<Queued[]>([]);
	/** Bumped when the worker ends, so a worker that arrives late is ended too. */
	const generationRef = useRef(0);
	const nextIdRef = useRef(1);
	const readyRef = useRef(new Map<number, () => void>());
	const configRef = useRef<ToArtWorker | null>(null);
	const factoryRef = useRef(createWorker);
	factoryRef.current = createWorker;

	const post = useCallback((msg: ToArtWorker, transfer: Transferable[] = []) => {
		if (workerRef.current !== null) workerRef.current.postMessage(msg, transfer);
		else if (startingRef.current) queueRef.current.push({ msg, transfer });
	}, []);

	const endWorker = useCallback(() => {
		generationRef.current++;
		workerRef.current?.terminate();
		workerRef.current = null;
		startingRef.current = false;
		queueRef.current = [];
	}, []);

	const ensureWorker = useCallback((): boolean => {
		if (workerRef.current !== null || startingRef.current) return true;
		if (!artEngineSupported()) return false;
		const generation = generationRef.current;
		const adopt = (worker: Worker) => {
			if (generation !== generationRef.current) {
				worker.terminate();
				return;
			}
			worker.addEventListener("message", (event: MessageEvent<FromArtWorker>) => {
				if (event.data.type === "ready") readyRef.current.get(event.data.id)?.();
			});
			workerRef.current = worker;
			startingRef.current = false;
			if (configRef.current !== null) worker.postMessage(configRef.current);
			const queued = queueRef.current;
			queueRef.current = [];
			// The current config went first; an older one still in the queue is dropped.
			for (const q of queued) if (q.msg.type !== "config") worker.postMessage(q.msg, q.transfer);
		};
		startingRef.current = true;
		let made: Worker | Promise<Worker>;
		try {
			made = factoryRef.current();
		} catch {
			startingRef.current = false;
			return false;
		}
		if (made instanceof Promise) {
			made.then(adopt, () => {
				if (generation === generationRef.current) {
					startingRef.current = false;
					queueRef.current = [];
				}
			});
		} else {
			adopt(made);
		}
		return true;
	}, []);

	// The choice, the mode and Reduce motion go to the worker as one config.
	useEffect(() => {
		const msg: ToArtWorker = {
			type: "config",
			config: { theme, city, dark, motion: !reduce, assets },
		};
		configRef.current = msg;
		if (theme === "none") {
			// None ends the worker; the layers unmount with the choice.
			endWorker();
			return;
		}
		post(msg);
	}, [theme, city, dark, reduce, assets, post, endWorker]);

	useEffect(() => endWorker, [endWorker]);

	// Hidden window or tab: the worker clears its timer; visible again, it
	// draws the current step once and resumes.
	useEffect(() => {
		const onVisibility = () => post({ type: document.hidden ? "pause" : "resume" });
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, [post]);

	const api = useMemo<ArtBackgroundApi>(
		() => ({
			theme,
			pixelated: theme !== "drafting",
			mount(canvas, onReady) {
				const id = nextIdRef.current++;
				readyRef.current.set(id, onReady);
				if (ensureWorker()) {
					const offscreen = canvas.transferControlToOffscreen();
					post({ type: "mount", id, canvas: offscreen }, [offscreen]);
					if (document.hidden) post({ type: "pause" });
				}
				return id;
			},
			layout(id: number, layout: ArtLayout) {
				post({ type: "layout", id, layout });
			},
			unmount(id) {
				readyRef.current.delete(id);
				post({ type: "unmount", id });
			},
		}),
		[theme, ensureWorker, post],
	);

	return <ArtBackgroundContext.Provider value={api}>{children}</ArtBackgroundContext.Provider>;
}
