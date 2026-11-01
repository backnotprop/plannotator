// Lofi: a small pixel city at night (design lane art/worlds/lofi.js, owner
// ruled the sixth theme 2026-10-02). One tile set, one palette per mode, and
// three cities that are DATA rows in CITIES: the drawing code knows no city.
// One art pixel is 2 CSS px. The still city is baked once per size, mode and
// city; a step (one a second) draws the movers: windows on their own slow
// clocks, mast lights, the lighthouse beam, reflections, the train, the
// ferry, cars, a plane, and the rain, drizzle or snow.

import { hash2, pixRng } from "../noise";
import type { Ctx } from "../pix";
import type { ArtCityId } from "../vocabulary";
import type { ArtScene, Box, ThemeDef, ThemeInstance } from "./types";

const P = 2;

type PalKey =
	| "far"
	| "mid"
	| "near"
	| "edge"
	| "roof"
	| "win"
	| "winWarm"
	| "winCool"
	| "winOff"
	| "star"
	| "moon"
	| "water"
	| "waterHi"
	| "ridge"
	| "ridge2"
	| "snowcap"
	| "road"
	| "rail"
	| "train"
	| "red"
	| "rain"
	| "snow"
	| "tree"
	| "head"
	| "tail"
	| "beam";
type Palette = Readonly<Record<PalKey, string>>;

const PAL: { readonly dark: Palette; readonly light: Palette } = {
	dark: {
		far: "#222a44",
		mid: "#2f3858",
		near: "#3b4670",
		edge: "#56638f",
		roof: "#4b5784",
		win: "#ffd27a",
		winWarm: "#ffae5a",
		winCool: "#a8d4ff",
		winOff: "#283050",
		star: "#d6defc",
		moon: "#f4ebc8",
		water: "#1b2440",
		waterHi: "#3c4d7e",
		ridge: "#252d47",
		ridge2: "#1f2640",
		snowcap: "#c4cfee",
		road: "#262d44",
		rail: "#5c6680",
		train: "#6b7699",
		red: "#ff5a52",
		rain: "#8ea6dc",
		snow: "#e6ecff",
		tree: "#2a3a48",
		head: "#fff2c0",
		tail: "#ff5a52",
		beam: "#ffe9a8",
	},
	light: {
		far: "#b4bad0",
		mid: "#959cba",
		near: "#78809f",
		edge: "#5d6688",
		roof: "#646d90",
		win: "#efa036",
		winWarm: "#e3822a",
		winCool: "#4f86cc",
		winOff: "#8a92b0",
		star: "#9aa3c4",
		moon: "#e79a52",
		water: "#9eaccb",
		waterHi: "#cfd8ec",
		ridge: "#a7aec7",
		ridge2: "#bcc2d6",
		snowcap: "#e9edf7",
		road: "#8c94b0",
		rail: "#5d6684",
		train: "#555f80",
		red: "#d9433a",
		rain: "#6278a6",
		snow: "#7f8bb2",
		tree: "#7d8a94",
		head: "#efa036",
		tail: "#d23a32",
		beam: "#efb24e",
	},
};

interface Style {
	readonly w: readonly [number, number];
	readonly h: readonly [number, number];
	readonly win: readonly [number, number];
	readonly pitch: readonly [number, number];
	readonly m: readonly [number, number];
	readonly roof: "flat" | "cornice" | "pitch" | "eave" | "saw";
	readonly toppers: readonly ("antenna" | "water" | null)[];
}
const STYLES: Readonly<Record<string, Style>> = {
	tower: {
		w: [14, 22],
		h: [40, 170],
		win: [1, 2],
		pitch: [3, 4],
		m: [2, 3],
		roof: "flat",
		toppers: ["antenna", "water", null, null],
	},
	glass: {
		w: [12, 20],
		h: [36, 150],
		win: [2, 1],
		pitch: [3, 3],
		m: [2, 3],
		roof: "flat",
		toppers: ["antenna", null],
	},
	tenement: {
		w: [10, 16],
		h: [18, 60],
		win: [2, 2],
		pitch: [4, 5],
		m: [2, 4],
		roof: "cornice",
		toppers: ["water", null, null],
	},
	house: {
		w: [9, 13],
		h: [10, 18],
		win: [2, 2],
		pitch: [4, 5],
		m: [2, 3],
		roof: "pitch",
		toppers: [null],
	},
	chalet: {
		w: [11, 15],
		h: [8, 13],
		win: [2, 2],
		pitch: [4, 5],
		m: [3, 3],
		roof: "eave",
		toppers: [null],
	},
	warehouse: {
		w: [20, 30],
		h: [9, 14],
		win: [3, 1],
		pitch: [6, 5],
		m: [3, 4],
		roof: "saw",
		toppers: [null],
	},
};

const KEY: Readonly<Record<string, PalKey>> = {
	n: "near",
	m: "mid",
	e: "edge",
	r: "roof",
	w: "win",
	o: "winOff",
	t: "tree",
	s: "snowcap",
	R: "red",
	f: "far",
	a: "train",
};
const STAMPS = {
	antenna: [".R.", ".e.", ".e.", ".e.", ".e.", ".e.", "eee"],
	water: ["..rrr..", ".rrrrr.", ".nnnnn.", ".nnnnn.", ".e...e.", ".e...e.", "eeeeeee"],
	pineSnow: ["..s..", ".sts.", "..t..", ".sts.", "ttttt", "..e.."],
	ferry: ["....ee......", "...eeee.....", ".nnwnwnwnnn.", "eeeeeeeeeeee", ".eeeeeeeeee."],
	car: [".nn.", "nnnn"],
	plane: ["e....", "eeeee", ".e..."],
} as const;

interface City {
	readonly weather: "drizzle" | "snow" | "rain";
	readonly ground: "water" | "valley" | "street";
	readonly groundH: number;
	readonly far?: { readonly h: readonly [number, number]; readonly w: readonly [number, number] };
	readonly ridge?: readonly (readonly [number, number])[];
	readonly near: {
		readonly h: readonly [number, number];
		readonly styles: readonly string[];
		readonly gap: readonly [number, number];
	};
	readonly landmarks: readonly (readonly ["crane" | "lighthouse" | "church" | "spire", number])[];
	readonly rail: number | null;
	readonly lit: number;
	readonly movers: readonly ("ferry" | "plane" | "train" | "cars")[];
	readonly snowRoofs?: boolean;
	readonly trees?: boolean;
}

/** The cities: data only. A new city is one row and no new code. */
export const CITIES: Readonly<Record<ArtCityId, City>> = {
	harbour: {
		weather: "drizzle",
		ground: "water",
		groundH: 0.13,
		far: { h: [0.05, 0.13], w: [6, 14] },
		near: { h: [0.04, 0.16], styles: ["tenement", "house", "house", "warehouse"], gap: [0, 2] },
		landmarks: [
			["crane", 0.07],
			["crane", 0.15],
			["lighthouse", 0.93],
		],
		rail: null,
		lit: 0.42,
		movers: ["ferry", "plane"],
	},
	mountain: {
		weather: "snow",
		ground: "valley",
		groundH: 0.05,
		ridge: [
			[0, 0.3],
			[0.1, 0.5],
			[0.2, 0.36],
			[0.35, 0.6],
			[0.47, 0.4],
			[0.6, 0.66],
			[0.74, 0.42],
			[0.86, 0.55],
			[1, 0.38],
		],
		near: { h: [0.03, 0.1], styles: ["chalet", "chalet", "house"], gap: [2, 12] },
		landmarks: [["church", 0.44]],
		rail: 0.15,
		lit: 0.5,
		movers: ["train"],
		snowRoofs: true,
		trees: true,
	},
	downtown: {
		weather: "rain",
		ground: "street",
		groundH: 0.05,
		far: { h: [0.18, 0.44], w: [8, 18] },
		near: { h: [0.1, 0.36], styles: ["tower", "glass", "tenement", "tower"], gap: [0, 2] },
		landmarks: [["spire", 0.64]],
		rail: 0.13,
		lit: 0.34,
		movers: ["train", "cars", "plane"],
	},
};

interface Flick {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	readonly id: number;
	readonly per: number;
	readonly ph: number;
	readonly col: PalKey;
}
interface Baked {
	readonly flick: Flick[];
	readonly lit: [number, number, number, number][];
	readonly blink: [number, number, number][];
	beam: [number, number] | null;
	railY: number | null;
	ground: { top: number; h: number };
}

function stamp(a: Ctx, pal: Palette, rows: readonly string[], x: number, y: number): void {
	for (let j = 0; j < rows.length; j++) {
		const row = rows[j]!;
		for (let i = 0; i < row.length; i++) {
			const k = KEY[row[i]!];
			if (k === undefined) continue;
			a.fillStyle = pal[k];
			a.fillRect(x + i, y + j, 1, 1);
		}
	}
}

function bakeCity(
	a: Ctx,
	AW: number,
	AH: number,
	dark: boolean,
	cityKey: ArtCityId,
	seed: string,
): Baked {
	const city = CITIES[cityKey];
	const pal = dark ? PAL.dark : PAL.light;
	const R = pixRng("lofi/" + cityKey + "/" + seed);
	const ri = (lo: number, hi: number) => Math.floor(lo + R() * (hi - lo + 1));
	const rect = (x: number, y: number, w: number, h: number, col: PalKey) => {
		a.fillStyle = pal[col];
		a.fillRect(x, y, w, h);
	};
	const base = Math.round(AH * (1 - city.groundH));
	const out: Baked = {
		flick: [],
		lit: [],
		blink: [],
		beam: null,
		railY: null,
		ground: { top: base, h: AH - base },
	};
	if (dark) {
		for (let n = 0; n < (AW * AH) / 1400; n++) {
			const x = (R() * AW) | 0;
			const y = (R() * AH * 0.5) | 0;
			rect(x, y, 1, 1, "star");
			if (R() < 0.06) {
				rect(x - 1, y, 3, 1, "star");
				rect(x, y - 1, 1, 3, "star");
			}
		}
	}
	const mx = Math.round(AW * 0.86);
	const my = Math.round(AH * 0.12);
	const mr = 7;
	for (let y = -mr; y <= mr; y++) {
		for (let x = -mr; x <= mr; x++) {
			if (x * x + y * y > mr * mr + 2) continue;
			if (dark && (x + 3) * (x + 3) + (y - 2) * (y - 2) < mr * mr - 4) continue;
			rect(mx + x, my + y, 1, 1, "moon");
		}
	}
	if (city.ridge) {
		const pts = city.ridge;
		const ridgeAt = (u: number, k: number) => {
			for (let i = 0; i < pts.length - 1; i++) {
				if (u <= pts[i + 1]![0]) {
					const s = (u - pts[i]![0]) / (pts[i + 1]![0] - pts[i]![0]);
					return (pts[i]![1] + (pts[i + 1]![1] - pts[i]![1]) * s) * k;
				}
			}
			return pts[pts.length - 1]![1] * k;
		};
		for (const [k, col, shift] of [
			[0.75, "ridge2", 0.07],
			[1, "ridge", 0],
		] as const) {
			for (let x = 0; x < AW; x++) {
				const u = (x / AW + shift) % 1;
				const h = Math.round(
					ridgeAt(u, k) * AH * 0.62 + Math.sin(x * 0.31) * 1.5 + Math.sin(x * 0.07) * 3,
				);
				const top = base - h;
				rect(x, top, 1, base - top, col);
				if (col === "ridge" && h > AH * 0.26) {
					for (let y = top; y < top + Math.min(6, h - AH * 0.25); y++) {
						if (y < top + 2 || ((x + y) % 2 === 0 && hash2(x, y) < 0.5))
							rect(x, y, 1, 1, "snowcap");
					}
				}
				if (col === "ridge" && city.trees && x % 7 === 0 && R() < 0.5) {
					const ty = base - Math.round(R() * h * 0.45) - 6;
					if (ty > top + 8) stamp(a, pal, STAMPS.pineSnow, x - 2, ty);
				}
			}
		}
	}
	if (city.far) {
		const far = city.far;
		for (let x = -4; x < AW + 4; ) {
			const w = ri(far.w[0], far.w[1]);
			const h = Math.round(AH * (far.h[0] + R() * (far.h[1] - far.h[0])));
			rect(x, base - h, w, h, "far");
			for (let y = base - h + 3; y < base - 2; y += 4) {
				for (let xx = x + 2; xx < x + w - 2; xx += 3)
					if (R() < 0.08) rect(xx, y, 1, 1, R() < 0.5 ? "winOff" : "win");
			}
			x += w + (R() < 0.3 ? 1 : 0);
		}
	}
	if (city.rail !== null && city.ground === "valley") {
		const y = base - Math.round(city.rail * AH);
		out.railY = y;
		for (let x = 0; x < AW; x += 26) {
			rect(x, y + 2, 3, base - y - 2, "mid");
			rect(x + 3, y + 3, 2, 1, "mid");
			rect(x - 2, y + 3, 2, 1, "mid");
		}
		rect(0, y, AW, 2, "edge");
		rect(0, y + 2, AW, 1, "mid");
	}
	let wid = 0;
	const windowAt = (x: number, y: number, ww: number, wh: number) => {
		const id = wid++;
		const lit = R() < city.lit;
		const col: PalKey = !lit
			? "winOff"
			: R() < 0.12
				? "winCool"
				: R() < 0.3
					? "winWarm"
					: "win";
		rect(x, y, ww, wh, col);
		if (lit) out.lit.push([x, y, ww, wh]);
		if (R() < 0.07) {
			out.flick.push({
				x,
				y,
				w: ww,
				h: wh,
				id,
				per: 20000 + Math.floor(R() * 70000),
				ph: Math.floor(R() * 90000),
				col: lit ? col : "win",
			});
		}
	};
	const building = (x: number, st: Style, w: number, h: number) => {
		const top = base - h;
		rect(x, top, w, h, "near");
		rect(x + w - 1, top, 1, h, "edge");
		for (let y = top + st.m[1]; y + st.win[1] <= base - 2; y += st.pitch[1]) {
			for (let xx = x + st.m[0]; xx + st.win[0] <= x + w - st.m[0]; xx += st.pitch[0])
				windowAt(xx, y, st.win[0], st.win[1]);
		}
		if (st.roof === "cornice") rect(x - 1, top - 1, w + 2, 1, "roof");
		if (st.roof === "pitch" || st.roof === "eave") {
			const o = st.roof === "eave" ? 2 : 0;
			const half = Math.ceil((w + o * 2) / 2);
			for (let k = 0; k < half; k++) {
				const hh = Math.min(k, half - 1);
				rect(x - o + k, top - hh - 1, 1, hh + 1, "roof");
				rect(x + w + o - 1 - k, top - hh - 1, 1, hh + 1, "roof");
			}
			if (city.snowRoofs) {
				for (let k = 0; k < half; k++) {
					const hh = Math.min(k, half - 1);
					rect(x - o + k, top - hh - 1, 1, 1, "snowcap");
					rect(x + w + o - 1 - k, top - hh - 1, 1, 1, "snowcap");
				}
			}
		}
		if (st.roof === "saw") {
			for (let k = 0; k < w; k++)
				rect(
					x + k,
					top - 1 - (k % 6 < 3 ? k % 6 : 0),
					1,
					1 + (k % 6 < 3 ? k % 6 : 0),
					"roof",
				);
		}
		const topper = st.toppers[Math.floor(R() * st.toppers.length)];
		if (topper === "antenna") {
			const tx = x + Math.floor(w / 2) - 1;
			stamp(a, pal, STAMPS.antenna, tx, top - 7);
			out.blink.push([tx + 1, top - 7, (R() * 2) | 0]);
		}
		if (topper === "water" && w >= 9)
			stamp(a, pal, STAMPS.water, x + 1 + ((R() * (w - 8)) | 0), top - 7);
	};
	for (let x = -3; x < AW + 3; ) {
		const sname = city.near.styles[Math.floor(R() * city.near.styles.length)]!;
		const st = STYLES[sname]!;
		const w = ri(st.w[0], st.w[1]);
		const h = Math.max(
			st.h[0],
			Math.min(
				st.h[1],
				Math.round(AH * (city.near.h[0] + R() * (city.near.h[1] - city.near.h[0]))),
			),
		);
		building(x, st, w, h);
		const gap = ri(city.near.gap[0], city.near.gap[1]);
		if (city.trees && gap >= 6)
			stamp(a, pal, STAMPS.pineSnow, x + w + Math.floor(gap / 2) - 2, base - 6);
		x += w + gap;
	}
	for (const [kind, u] of city.landmarks) {
		const x = Math.round(AW * u);
		if (kind === "crane") {
			const h = Math.round(AH * 0.2);
			const top = base - h;
			for (let y = top; y < base; y++) {
				rect(x, y, 1, 1, "edge");
				rect(x + 2, y, 1, 1, "edge");
				if ((y - top) % 3 === 0) rect(x + 1, y, 1, 1, "edge");
			}
			rect(x - 26, top, 36, 1, "edge");
			for (let k = -26; k < 10; k += 3) rect(x + k, top + 1, 1, 1, "edge");
			rect(x - 1, top - 4, 1, 4, "edge");
			rect(x + 9, top + 1, 2, 3, "mid");
			rect(x - 20, top + 1, 1, 14, "mid");
			rect(x - 21, top + 15, 3, 2, "edge");
			out.blink.push([x - 1, top - 5, 1]);
		}
		if (kind === "lighthouse") {
			rect(x - 6, base - 2, 14, 3, "ridge");
			const h = 30;
			const top = base - 2 - h;
			for (let k = 0; k < h; k++) {
				const ww = 3 + Math.round((k / h) * 3);
				rect(
					x - Math.floor(ww / 2) + 1,
					top + k,
					ww,
					1,
					Math.floor(k / 5) % 2 ? "near" : "edge",
				);
			}
			rect(x - 1, top - 3, 5, 3, "win");
			rect(x - 2, top - 5, 7, 2, "roof");
			rect(x + 1, top - 6, 1, 1, "roof");
			out.beam = [x + 1, top - 2];
		}
		if (kind === "church") {
			const nw = 16;
			const nh = 11;
			const top = base - nh;
			rect(x, top, nw, nh, "near");
			rect(x + nw - 1, top, 1, nh, "edge");
			for (let k = 0; k < 9; k++) {
				rect(x - 1 + k, top - k, 1, k + 1, "roof");
				rect(x + nw - k, top - k, 1, k + 1, "roof");
				rect(x - 1 + k, top - k, 1, 1, "snowcap");
				rect(x + nw - k, top - k, 1, 1, "snowcap");
			}
			const sx = x + nw;
			const sh = 26;
			rect(sx, base - sh, 6, sh, "near");
			rect(sx + 5, base - sh, 1, sh, "edge");
			rect(sx + 2, base - sh + 4, 2, 3, "win");
			out.lit.push([sx + 2, base - sh + 4, 2, 3]);
			for (let k = 0; k < 10; k++)
				rect(
					sx + 3 - Math.floor(k / 4),
					base - sh - 10 + k,
					1 + 2 * Math.floor(k / 4),
					1,
					"roof",
				);
			rect(sx + 3, base - sh - 13, 1, 3, "edge");
			rect(sx + 2, base - sh - 12, 3, 1, "edge");
			for (let k = 0; k < 3; k++) windowAt(x + 3 + k * 4, top + 4, 2, 4);
		}
		if (kind === "spire") {
			const w = 22;
			const h = Math.round(AH * 0.52);
			const top = base - h;
			const steps: [number, number][] = [
				[0, w],
				[Math.round(h * 0.35), w - 6],
				[Math.round(h * 0.6), w - 12],
			];
			for (let s = 0; s < steps.length; s++) {
				const [y0, ww] = steps[s]!;
				const y1 = s + 1 < steps.length ? steps[s + 1]![0] : h;
				const xo = x + Math.floor((w - ww) / 2);
				rect(xo, base - y1, ww, y1 - y0, "near");
				rect(xo + ww - 1, base - y1, 1, y1 - y0, "edge");
				for (let y = base - y1 + 3; y + 2 <= base - y0 - 2; y += 4) {
					for (let xx = xo + 2; xx + 1 <= xo + ww - 2; xx += 3) windowAt(xx, y, 1, 2);
				}
			}
			const tx = x + Math.floor(w / 2);
			rect(tx - 1, top - 4, 3, 4, "roof");
			rect(tx, top - 22, 1, 18, "edge");
			out.blink.push([tx, top - 23, 0]);
		}
	}
	if (city.rail !== null && city.ground !== "valley") {
		const y = base - Math.round(city.rail * AH);
		out.railY = y;
		for (let x = 6; x < AW; x += 34) rect(x, y + 2, 2, base - y - 2, "mid");
		rect(0, y, AW, 2, "edge");
		rect(0, y + 2, AW, 1, "mid");
	}
	if (city.ground === "water") {
		rect(0, base, AW, AH - base, "water");
		rect(0, base, AW, 1, "edge");
		for (let n = 0; n < AW / 6; n++)
			rect(
				(R() * AW) | 0,
				base + 3 + ((R() * (AH - base - 4)) | 0),
				2 + ((R() * 4) | 0),
				1,
				"waterHi",
			);
	}
	if (city.ground === "street") {
		rect(0, base, AW, AH - base, "road");
		rect(0, base, AW, 1, "edge");
		const mid = base + Math.floor((AH - base) / 2);
		for (let x = 0; x < AW; x += 9) rect(x, mid, 4, 1, "winOff");
	}
	if (city.ground === "valley") {
		rect(0, base, AW, AH - base, "ridge");
		for (let y = base; y < AH; y++)
			for (let x = y % 2; x < AW; x += 2) if (hash2(x, y) < 0.18) rect(x, y, 1, 1, "snowcap");
	}
	return out;
}

function create(scene: ArtScene): ThemeInstance {
	const AW = scene.LW;
	const AH = scene.LH;
	const city = CITIES[scene.city];
	const pal = scene.dark ? PAL.dark : PAL.light;
	let B: Baked | null = null;
	return {
		bake(g) {
			B = bakeCity(g, AW, AH, scene.dark, scene.city, scene.seed);
		},
		step(t0, g) {
			if (B === null) return [];
			const b = B;
			const t = scene.motion ? t0 : 0;
			const step = Math.floor(t / 1000);
			const boxes: Box[] = [];
			const rect = (x: number, y: number, w: number, h: number, col: PalKey) => {
				const rx = Math.round(x);
				const ry = Math.round(y);
				g.fillStyle = pal[col];
				g.fillRect(rx, ry, w, h);
				boxes.push({ x: rx, y: ry, w, h });
			};
			const stampAt = (rows: readonly string[], x: number, y: number) => {
				for (let j = 0; j < rows.length; j++) {
					const row = rows[j]!;
					for (let i = 0; i < row.length; i++) {
						const k = KEY[row[i]!];
						if (k !== undefined) rect(x + i, y + j, 1, 1, k);
					}
				}
			};
			for (const f of b.flick) {
				const on = hash2(f.id, Math.floor((t + f.ph) / f.per)) < (scene.motion ? 0.55 : 1);
				rect(f.x, f.y, f.w, f.h, on ? f.col : "winOff");
			}
			for (const [x, y, ph] of b.blink)
				if (!scene.motion || (step + ph) % 2 === 0) rect(x, y, 1, 1, "red");
			if (b.beam !== null) {
				const dir = scene.motion && Math.floor(step / 3) % 2 ? -1 : 1;
				for (let k = 2; k < 22; k += 2)
					if (hash2(k, step) < 0.8) rect(b.beam[0] + dir * k, b.beam[1], 1, 1, "beam");
			}
			if (city.ground === "water") {
				let n = 0;
				for (let i = 0; i < b.lit.length && n < 140; i += 3, n++) {
					const [x, , w] = b.lit[i]!;
					for (let k = 0; k < 3; k++) {
						const y = b.ground.top + 2 + k * 3 + ((hash2(i, k) * 2) | 0);
						if (y >= AH) continue;
						const j = ((hash2(i * 7 + k, step) * 3) | 0) - 1;
						if (hash2(i, k + step * 3) < 0.75)
							rect(x + j, y, Math.max(1, w - (k > 1 ? 1 : 0)), 1, "waterHi");
					}
				}
			}
			if (city.movers.includes("ferry")) {
				const span = AW + 30;
				const x = scene.motion
					? ((Math.floor(t / 2000) + 140) % span) - 15
					: Math.round(AW * 0.42);
				stampAt(STAMPS.ferry, x, b.ground.top + Math.round(b.ground.h * 0.35));
			}
			if (city.movers.includes("train") && b.railY !== null) {
				const cars = 4;
				const carW = 14;
				const len = cars * (carW + 1);
				const x = scene.motion
					? -len + Math.floor((t % 180000) / 1000) * 6
					: Math.round(AW * 0.22);
				if (x < AW && x > -len) {
					for (let k = 0; k < cars; k++) {
						const cx = x + k * (carW + 1);
						const y = b.railY - 5;
						rect(cx, y, carW, 5, "train");
						for (let q = 2; q < carW - 2; q += 3)
							rect(cx + q, y + 1, 2, 2, (k * 5 + q) % 7 === 0 ? "winOff" : "win");
						if (k === cars - 1) rect(cx + carW - 1, y + 3, 1, 1, "head");
					}
				}
			}
			if (city.movers.includes("cars")) {
				for (let i = 0; i < 4; i++) {
					const dir = i % 2 ? -1 : 1;
					const speed = 4 + i;
					const span = AW + 20;
					const p = scene.motion ? (step * speed + i * 173) % span : (i * 211) % span;
					const x = dir > 0 ? p - 10 : AW + 10 - p;
					const y =
						b.ground.top +
						(dir > 0 ? Math.round(b.ground.h * 0.62) : Math.round(b.ground.h * 0.22));
					stampAt(STAMPS.car, x, y);
					rect(dir > 0 ? x + 4 : x - 1, y + 1, 1, 1, "head");
					rect(dir > 0 ? x - 1 : x + 4, y + 1, 1, 1, "tail");
				}
			}
			if (scene.motion && city.movers.includes("plane")) {
				const x = AW + 8 - Math.floor((t % 360000) / 1000) * 3;
				const y = Math.round(AH * 0.09);
				if (x > -8 && x < AW + 8) {
					stampAt(STAMPS.plane, x, y);
					if (step % 2 === 0) rect(x + 4, y + 2, 1, 1, "red");
				}
			}
			const area = AW * AH;
			if (city.weather === "rain" || city.weather === "drizzle") {
				const n = Math.floor(area / (city.weather === "rain" ? 650 : 1500));
				for (let i = 0; i < n; i++) {
					const x0 = hash2(i, 1) * AW;
					const y0 = hash2(i, 2) * AH;
					const y = Math.round((y0 + step * 23) % AH);
					const x = Math.round((((x0 - step * 5) % AW) + AW) % AW);
					rect(x, y, 1, 2, "rain");
					rect(x - 1, y + 2, 1, 1, "rain");
				}
			}
			if (city.weather === "snow") {
				const n = Math.floor(area / 900);
				for (let i = 0; i < n; i++) {
					const x0 = hash2(i, 3) * AW;
					const y0 = hash2(i, 4) * AH;
					const sp = 1 + ((hash2(i, 5) * 3) | 0);
					const y = (y0 + step * sp) % AH;
					const x = (x0 + Math.round(Math.sin(step * 0.25 + i) * 1.5) + AW) % AW;
					rect(x, y, 1, 1, "snow");
				}
			}
			return boxes;
		},
	};
}

export const lofi: ThemeDef = {
	id: "lofi",
	maxAlpha: [0.19, 0.27],
	pad: 20,
	ramp: 70,
	shape: null,
	stepMs: 1000,
	scale: () => 1 / P,
	pixelated: true,
	cpuBake: false,
	movers: "dyn",
	bakeReadsMask: false,
	create,
};
