// The art engine, run inside the art worker (art.worker.ts). One clock for
// every layer: a setTimeout chain at the theme's step, never a frame loop.
// Per layer it keeps three canvases at the theme's own resolution: the still
// plate (baked once per size, mode and layout), the movers, and the mask
// plate (built when the layout changes, never per step). A step draws only
// what moved and composes only those boxes onto the visible canvas:
// plate, then movers, then `destination-in` the mask plate, whose alpha is
// the quiet mask capped at the theme's contrast ceiling. Nothing is read back
// from the visible canvas.

import { mergeBoxes } from "./boxes";
import { buildMask, MASK_CELL, type Mask } from "./mask";
import { canvas, ctx2d, type Ctx } from "./pix";
import type {
	ArtAssets,
	ArtConfig,
	ArtLayout,
	ArtStats,
	FromArtWorker,
	ToArtWorker,
} from "./protocol";
import { THEMES } from "./themes";
import type { ArtScene, Box, ThemeDef, ThemeInstance } from "./themes/types";
import type { ArtCityId, ArtThemeId } from "./vocabulary";

export const ART_SEED = "ws-2026-10-01";
const STATS_KEPT = 600;

export interface ArtEngineEnv {
	now(): number;
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(id: number): void;
	post(msg: FromArtWorker, transfer?: Transferable[]): void;
	/** Wall-clock ms for the art's time (the clock is a function of time). */
	clock(): number;
	loadImage(url: string): Promise<CanvasImageSource>;
	loadFont(family: string, url: string): Promise<void>;
}

interface Layer {
	readonly id: number;
	readonly visible: OffscreenCanvas;
	readonly g: Ctx;
	layout: ArtLayout | null;
	theme: ThemeDef | null;
	inst: ThemeInstance | null;
	scene: ArtScene | null;
	bake: OffscreenCanvas | null;
	dyn: OffscreenCanvas | null;
	plate: OffscreenCanvas | null;
	plateW: number;
	plateH: number;
	plateSmooth: boolean;
	prev: readonly Box[];
	/** The key of the frame on screen. */
	key: string | null;
	drawn: boolean;
}

function maskPlate(mask: Mask, cap: number): OffscreenCanvas {
	const c = canvas(mask.gw, mask.gh);
	const g = ctx2d(c);
	const img = g.createImageData(mask.gw, mask.gh);
	const top = Math.round(255 * cap);
	for (let i = 0; i < mask.grid.length; i++) {
		const v = Math.round(Math.max(0, Math.min(1, mask.grid[i] ?? 0)) * 255);
		img.data[i * 4 + 3] = v < top ? v : top;
	}
	g.putImageData(img, 0, 0);
	return c;
}

export class ArtEngine {
	private config: ArtConfig | null = null;
	private readonly layers = new Map<number, Layer>();
	private timer: number | null = null;
	private paused = false;
	private totman: CanvasImageSource | null = null;
	private totmanUrl: string | null = null;
	private monoUrl: string | null = null;
	private readonly steps: number[] = [];
	private readonly bakes: number[] = [];

	constructor(private readonly env: ArtEngineEnv) {}

	handle(msg: ToArtWorker): void {
		switch (msg.type) {
			case "config":
				this.config = msg.config;
				this.loadAssets(msg.config.assets);
				for (const layer of this.layers.values()) this.rebuild(layer);
				this.schedule();
				return;
			case "mount": {
				const g = ctx2d(msg.canvas);
				this.layers.set(msg.id, {
					id: msg.id,
					visible: msg.canvas,
					g,
					layout: null,
					theme: null,
					inst: null,
					scene: null,
					bake: null,
					dyn: null,
					plate: null,
					plateW: 0,
					plateH: 0,
					plateSmooth: true,
					prev: [],
					key: null,
					drawn: false,
				});
				return;
			}
			case "layout": {
				const layer = this.layers.get(msg.id);
				if (layer === undefined) return;
				layer.layout = msg.layout;
				this.rebuild(layer);
				this.env.post({ type: "ready", id: msg.id });
				this.schedule();
				return;
			}
			case "unmount":
				this.layers.delete(msg.id);
				this.schedule();
				return;
			case "pause":
				this.paused = true;
				this.schedule();
				return;
			case "resume":
				this.paused = false;
				// Nothing catches up: the current step is drawn once.
				for (const layer of this.layers.values()) this.frame(layer, false);
				this.schedule();
				return;
			case "thumb": {
				const target = canvas(128, 80);
				this.thumb(target, msg.theme, msg.city, msg.assets);
				const bitmap = target.transferToImageBitmap();
				this.env.post({ type: "thumb", key: msg.key, bitmap }, [bitmap]);
				return;
			}
			case "stats":
				this.env.post({ type: "stats", stats: this.stats() });
				return;
		}
	}

	stats(): ArtStats {
		return {
			timers: this.timer === null ? 0 : 1,
			steps: [...this.steps],
			bakes: [...this.bakes],
			drawn: [...this.layers.values()].filter((l) => l.drawn).map((l) => l.id),
		};
	}

	private loadAssets(assets: ArtAssets): void {
		if (assets.totman !== this.totmanUrl) {
			this.totmanUrl = assets.totman;
			const url = assets.totman;
			this.env.loadImage(url).then(
				(img) => {
					if (this.totmanUrl !== url) return;
					this.totman = img;
					for (const layer of this.layers.values())
						if (layer.theme?.id === "skifree") this.rebuild(layer);
				},
				() => {},
			);
		}
		if (assets.mono !== this.monoUrl) {
			this.monoUrl = assets.mono;
			this.env.loadFont("Ioskeley Mono", assets.mono).then(
				() => {
					for (const layer of this.layers.values())
						if (layer.theme?.id === "drafting") this.rebuild(layer);
				},
				() => {},
			);
		}
	}

	private themeOf(id: ArtThemeId): ThemeDef | null {
		return id === "none" ? null : THEMES[id];
	}

	/** Size, mask, plates and the first frame, for a new layout or choice. */
	private rebuild(layer: Layer): void {
		const cfg = this.config;
		const layout = layer.layout;
		const theme = cfg === null ? null : this.themeOf(cfg.theme);
		layer.theme = theme;
		if (cfg === null || layout === null || theme === null || layout.w < 8 || layout.h < 8) {
			layer.inst = null;
			layer.scene = null;
			layer.visible.width = 1;
			layer.visible.height = 1;
			return;
		}
		const t0 = this.env.now();
		const scale = theme.scale(layout.dpr);
		const LW = Math.max(1, Math.ceil(layout.w * scale));
		const LH = Math.max(1, Math.ceil(layout.h * scale));
		const mask = buildMask(
			layout.w,
			layout.h,
			layout.rects,
			theme.pad,
			theme.ramp,
			theme.shape,
		);
		const scene: ArtScene = {
			W: layout.w,
			H: layout.h,
			dpr: layout.dpr,
			dark: cfg.dark,
			motion: cfg.motion,
			active: layout.active,
			city: cfg.city,
			mask,
			totman: this.totman,
			seed: ART_SEED,
			LW,
			LH,
		};
		const inst = theme.create(scene);
		if (layer.visible.width !== LW) layer.visible.width = LW;
		if (layer.visible.height !== LH) layer.visible.height = LH;
		const bake = canvas(LW, LH);
		// A "plate" theme draws on the plate; it gets no movers canvas.
		const dyn = canvas(theme.movers === "dyn" ? LW : 1, theme.movers === "dyn" ? LH : 1);
		const bakeCtx = ctx2d(bake, theme.cpuBake);
		if (inst.maskPlate !== undefined) {
			layer.plate = inst.maskPlate();
			layer.plateW = LW;
			layer.plateH = LH;
			layer.plateSmooth = false;
		} else {
			const small = maskPlate(mask, theme.cpuBake ? 1 : theme.maxAlpha[cfg.dark ? 0 : 1]);
			const pw = mask.gw * MASK_CELL * scale;
			const ph = mask.gh * MASK_CELL * scale;
			if (scale <= 1) {
				// Scaled once to the layer, so a step composes it 1:1.
				const full = canvas(LW, LH);
				const fg = ctx2d(full);
				fg.imageSmoothingEnabled = true;
				fg.drawImage(small, 0, 0, pw, ph);
				layer.plate = full;
				layer.plateW = LW;
				layer.plateH = LH;
				layer.plateSmooth = false;
			} else {
				// The device-scale layer (Drafting) keeps the small plate and
				// scales it per compose rather than hold another full bitmap.
				layer.plate = small;
				layer.plateW = pw;
				layer.plateH = ph;
				layer.plateSmooth = true;
			}
		}
		inst.bake(bakeCtx);
		layer.inst = inst;
		layer.scene = scene;
		layer.bake = bake;
		layer.dyn = dyn;
		layer.prev = [];
		this.frame(layer, true);
		this.bakes.push(this.env.now() - t0);
		if (this.bakes.length > STATS_KEPT) this.bakes.shift();
	}

	/** Draw the movers at the current time and compose what changed. */
	private frame(layer: Layer, full: boolean): void {
		const { inst, scene, bake, dyn } = layer;
		if (inst === null || scene === null || bake === null || dyn === null) return;
		const now = this.env.clock();
		const key = inst.key?.(scene.motion ? now : 0) ?? null;
		if (!full && key !== null && key === layer.key) return;
		layer.key = key;
		const onDyn = layer.theme?.movers === "dyn";
		const dynCtx = ctx2d(dyn);
		for (const b of layer.prev) dynCtx.clearRect(b.x, b.y, b.w, b.h);
		const bakeCtx = ctx2d(bake, layer.theme?.cpuBake ?? false);
		const drew = inst.step(now, dynCtx, bakeCtx);
		const all = full || drew === "all";
		const boxes = drew === "all" ? [] : drew;
		const dirty = all
			? [{ x: 0, y: 0, w: scene.LW, h: scene.LH }]
			: mergeBoxes(onDyn ? [...layer.prev, ...boxes] : boxes, scene.LW, scene.LH);
		layer.prev = !onDyn
			? []
			: drew === "all"
				? [{ x: 0, y: 0, w: scene.LW, h: scene.LH }]
				: boxes;
		this.compose(layer, dirty);
		layer.drawn = true;
	}

	private compose(layer: Layer, rects: readonly Box[]): void {
		const { g, bake, dyn, plate } = layer;
		if (bake === null || dyn === null || plate === null) return;
		const cpu = layer.theme?.cpuBake ?? false;
		const onDyn = layer.theme?.movers === "dyn";
		g.imageSmoothingEnabled = false;
		for (const r of rects) {
			g.save();
			g.beginPath();
			g.rect(r.x, r.y, r.w, r.h);
			g.clip();
			if (cpu) {
				// A CPU-backed plate is copied region by region: drawing it whole
				// would snapshot all of it after every change.
				g.putImageData(ctx2d(bake, true).getImageData(r.x, r.y, r.w, r.h), r.x, r.y);
			} else {
				g.clearRect(r.x, r.y, r.w, r.h);
				g.globalCompositeOperation = "source-over";
				g.drawImage(bake, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
			}
			if (onDyn) g.drawImage(dyn, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
			g.globalCompositeOperation = "destination-in";
			if (plate.width === layer.plateW && plate.height === layer.plateH) {
				g.drawImage(plate, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
			} else {
				g.imageSmoothingEnabled = layer.plateSmooth;
				g.drawImage(plate, 0, 0, layer.plateW, layer.plateH);
			}
			g.restore();
		}
	}

	private tick = (): void => {
		this.timer = null;
		for (const layer of this.layers.values()) {
			const t0 = this.env.now();
			this.frame(layer, false);
			if (layer.inst !== null) {
				this.steps.push(this.env.now() - t0);
				if (this.steps.length > STATS_KEPT) this.steps.shift();
			}
		}
		this.schedule();
	};

	/** Keep exactly one timer while something animates, and none otherwise. */
	private schedule(): void {
		const cfg = this.config;
		const theme = cfg === null ? null : this.themeOf(cfg.theme);
		const live = [...this.layers.values()].some((l) => l.inst !== null);
		const want = theme !== null && cfg !== null && cfg.motion && !this.paused && live;
		if (!want) {
			if (this.timer !== null) this.env.clearTimeout(this.timer);
			this.timer = null;
			return;
		}
		if (this.timer !== null) return;
		const step = theme.stepMs;
		const wait = step - (this.env.clock() % step);
		this.timer = this.env.setTimeout(this.tick, wait < 50 ? wait + step : wait);
	}

	/** A still thumbnail for the settings row: full ink over a dark ground. */
	private thumb(
		target: OffscreenCanvas,
		id: ArtThemeId,
		city: ArtCityId,
		assets: ArtAssets,
	): void {
		const theme = this.themeOf(id);
		const g = ctx2d(target);
		g.fillStyle = "#14171f";
		g.fillRect(0, 0, target.width, target.height);
		if (theme === null) return;
		this.loadAssets(assets);
		const W = 192;
		const H = 120;
		const scale = theme.scale(1);
		const LW = Math.ceil(W * scale);
		const LH = Math.ceil(H * scale);
		const mask = buildMask(W, H, [], theme.pad, theme.ramp, null);
		const scene: ArtScene = {
			W,
			H,
			dpr: 1,
			dark: true,
			motion: false,
			active: false,
			city,
			mask,
			totman: this.totman,
			seed: ART_SEED,
			LW,
			LH,
		};
		const inst = theme.create(scene);
		const off = canvas(LW, LH);
		const og = ctx2d(off, theme.cpuBake);
		const plate = inst.maskPlate?.();
		inst.bake(og);
		const dyn = canvas(LW, LH);
		inst.step(this.env.clock(), ctx2d(dyn), og);
		og.drawImage(dyn, 0, 0);
		if (plate !== undefined) {
			// Weather's plate carries its dither clearing; the thumbnail shows it opaque.
			const lit = canvas(LW, LH);
			const lg = ctx2d(lit);
			lg.drawImage(plate, 0, 0);
			lg.globalCompositeOperation = "source-in";
			lg.fillStyle = "#fff";
			lg.fillRect(0, 0, LW, LH);
			og.globalCompositeOperation = "destination-in";
			og.drawImage(lit, 0, 0);
			og.globalCompositeOperation = "source-over";
		}
		g.globalAlpha = 0.85;
		g.imageSmoothingEnabled = true;
		g.drawImage(off, 0, 0, target.width, target.height);
		g.globalAlpha = 1;
	}
}
