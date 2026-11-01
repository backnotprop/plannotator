// The messages between the main thread and the art worker. The main thread
// sends the canvases once, then only layout (on resize, route change and
// scroll end), the choice, and pause or resume. A step posts nothing back:
// the worker answers only `ready` (a layer's first frame for a layout, so the
// layer can fade in) and, for tests and the budget check, `stats`.

import type { ArtRect } from "./mask";
import type { ArtCityId, ArtThemeId } from "./vocabulary";

export interface ArtAssets {
	/** Totman's 20 px ski cut (Slope). */
	readonly totman: string;
	/** Ioskeley Mono, for Drafting's title block. */
	readonly mono: string;
}

export interface ArtConfig {
	readonly theme: ArtThemeId;
	readonly city: ArtCityId;
	readonly dark: boolean;
	/** False under `prefers-reduced-motion: reduce`: one still frame, no timer. */
	readonly motion: boolean;
	readonly assets: ArtAssets;
}

export interface ArtLayout {
	/** The ground's visible box, CSS px. */
	readonly w: number;
	readonly h: number;
	readonly dpr: number;
	/** Keep rectangles relative to that box. */
	readonly rects: readonly ArtRect[];
	/** An agent panel is open over the ground. */
	readonly active: boolean;
}

export type ToArtWorker =
	| { readonly type: "config"; readonly config: ArtConfig }
	| { readonly type: "mount"; readonly id: number; readonly canvas: OffscreenCanvas }
	| { readonly type: "layout"; readonly id: number; readonly layout: ArtLayout }
	| { readonly type: "unmount"; readonly id: number }
	| { readonly type: "pause" }
	| { readonly type: "resume" }
	| {
			readonly type: "thumb";
			readonly key: string;
			readonly theme: ArtThemeId;
			readonly city: ArtCityId;
			readonly assets: ArtAssets;
	  }
	| { readonly type: "stats" };

export interface ArtStats {
	/** Pending step timers (0 or 1: one clock for every layer). */
	readonly timers: number;
	/** Worker time of each timed step, ms. */
	readonly steps: readonly number[];
	/** Worker time of each rebuild (mask, plates, first frame), ms. */
	readonly bakes: readonly number[];
	/** Layers drawn at least once. */
	readonly drawn: readonly number[];
}

export type FromArtWorker =
	| { readonly type: "ready"; readonly id: number }
	/** A settings thumbnail, 128 by 80 (64 by 40 CSS px at 2x). */
	| { readonly type: "thumb"; readonly key: string; readonly bitmap: ImageBitmap }
	| { readonly type: "stats"; readonly stats: ArtStats };
