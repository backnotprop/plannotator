// Still thumbnails for a background picker, drawn once from each theme by a
// short-lived art worker that ends when the picker unmounts. Without a worker
// (an old browser, a test DOM) the frames stay empty.

import { useEffect, useRef } from "react";

import { artEngineSupported, type ArtWorkerFactory } from "./ArtBackgroundProvider";
import { ART_DEFAULT_ASSETS } from "./assets";
import type { ArtAssets, FromArtWorker, ToArtWorker } from "./protocol";
import { ART_CITY_IDS, ART_THEME_IDS } from "./vocabulary";

/** The thumbnail canvas's size in pixels (64 by 40 CSS px at 2x). */
export const ART_THUMB_WIDTH = 128;
export const ART_THUMB_HEIGHT = 80;

/**
 * Returns a ref factory: `thumb(themeId)` for a theme's tile, and
 * `thumb("city:" + cityId)` for a Lofi city's tile.
 */
export function useArtThumbnails(
	createWorker: ArtWorkerFactory,
	assets: ArtAssets = ART_DEFAULT_ASSETS,
): (key: string) => (el: HTMLCanvasElement | null) => void {
	const canvases = useRef(new Map<string, HTMLCanvasElement>());
	const bitmaps = useRef(new Map<string, ImageBitmap>());
	const factoryRef = useRef(createWorker);
	factoryRef.current = createWorker;
	const paint = (key: string) => {
		const target = canvases.current.get(key);
		const bitmap = bitmaps.current.get(key);
		if (target === undefined || bitmap === undefined) return;
		const g = target.getContext("2d");
		g?.clearRect(0, 0, target.width, target.height);
		g?.drawImage(bitmap, 0, 0, target.width, target.height);
	};
	useEffect(() => {
		if (!artEngineSupported()) return;
		const kept = bitmaps.current;
		let worker: Worker | null = null;
		let ended = false;
		const start = (made: Worker) => {
			if (ended) {
				made.terminate();
				return;
			}
			worker = made;
			made.addEventListener("message", (event: MessageEvent<FromArtWorker>) => {
				if (event.data.type !== "thumb") return;
				kept.get(event.data.key)?.close();
				kept.set(event.data.key, event.data.bitmap);
				paint(event.data.key);
			});
			const ask = (key: string, theme: (typeof ART_THEME_IDS)[number], city: (typeof ART_CITY_IDS)[number]) =>
				made.postMessage({ type: "thumb", key, theme, city, assets } satisfies ToArtWorker);
			for (const theme of ART_THEME_IDS) if (theme !== "none") ask(theme, theme, "harbour");
			for (const city of ART_CITY_IDS) ask("city:" + city, "lofi", city);
		};
		try {
			const made = factoryRef.current();
			if (made instanceof Promise) made.then(start, () => {});
			else start(made);
		} catch {
			return;
		}
		return () => {
			ended = true;
			worker?.terminate();
			for (const bitmap of kept.values()) bitmap.close();
			kept.clear();
		};
		// The thumbnails are drawn once per picker; a new assets object does not redraw them.
	}, []);
	return (key: string) => (el: HTMLCanvasElement | null) => {
		if (el === null) {
			canvases.current.delete(key);
			return;
		}
		canvases.current.set(key, el);
		paint(key);
	};
}
