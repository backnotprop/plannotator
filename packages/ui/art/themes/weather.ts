// Weather (design lane art/art.js): a sky through the 4 by 4 ordered dither
// at 2 px per cell, banked to the sides, open in the middle, dissolving into
// the ground by the same matrix. The palette follows the local clock.
//
// The engine form (spec section 3): the cloud field is baked once into a
// plate wider than the ground, and a step moves it one cell. The clouds drift
// 2 px every 10 s (the sheet's 1 px every 5 s); the field is rebaked only when
// its margin runs out (about every ten minutes) or the hour changes the
// palette. The dither's clearing around the work is the mask plate itself,
// built when the layout changes, with the ceiling as its alpha.

import { BAYER, clamp, fbm, lerp, rng, smooth, xmur3, type Rgb } from "../noise";
import { canvas, ctx2d } from "../pix";
import type { ArtScene, ThemeDef, ThemeInstance } from "./types";

const CELL = 2;
const DRIFT_MS = 10000;
const MARGIN = 64;

type Tod = "dawn" | "day" | "dusk" | "night";
const SKIES: Readonly<Record<Tod, { sky: readonly [Rgb, Rgb]; cloud: readonly [Rgb, Rgb] }>> = {
	dawn: {
		sky: [
			[118, 132, 196],
			[214, 176, 196],
		],
		cloud: [
			[236, 168, 150],
			[252, 226, 204],
		],
	},
	day: {
		sky: [
			[76, 128, 222],
			[150, 188, 238],
		],
		cloud: [
			[206, 216, 236],
			[252, 252, 255],
		],
	},
	dusk: {
		sky: [
			[86, 104, 214],
			[176, 140, 220],
		],
		cloud: [
			[232, 132, 176],
			[252, 206, 196],
		],
	},
	night: {
		sky: [
			[22, 30, 64],
			[38, 52, 98],
		],
		cloud: [
			[62, 74, 120],
			[118, 130, 176],
		],
	},
};

export function timeOfDay(dark: boolean, hour: number): Tod {
	if (dark) return hour >= 17 && hour < 21 ? "dusk" : "night";
	return hour < 9 ? "dawn" : hour < 17 ? "day" : "dusk";
}

const MAX_ALPHA: readonly [number, number] = [0.38, 0.5];

function create(scene: ArtScene): ThemeInstance {
	const { W, H, mask } = scene;
	const cw = scene.LW;
	const ch = scene.LH;
	const seed = xmur3("weather/" + scene.seed) % 1000;
	// the sky's opacity ceiling at the very top, then the theme's ceiling
	const top = scene.dark ? 0.6 : 0.5;
	const A = Math.min(top, MAX_ALPHA[scene.dark ? 0 : 1]);
	let field: OffscreenCanvas | null = null;
	let fieldK0 = 0;
	let fieldTod: Tod | null = null;
	let drawnK: number | null = null;
	let drawnTod: Tod | null = null;
	// Rows with no kept cell are skipped by the field bake.
	const liveRows = new Uint8Array(ch);

	function maskPlate(): OffscreenCanvas {
		const c = canvas(cw, ch);
		const g = ctx2d(c, true);
		const img = g.createImageData(cw, ch);
		const alpha = Math.round(255 * A);
		liveRows.fill(0);
		field = null;
		for (let y = 0; y < ch; y++) {
			for (let x = 0; x < cw; x++) {
				const px = x * CELL;
				const py = y * CELL;
				const m0 = mask.at(px, py);
				if (m0 <= 0.001) continue;
				// the clearing takes the clouds' shape, never a rectangle's
				const m =
					m0 *
					smooth(0.12, 0.62, m0 + (fbm(px / 150, py / 110, seed + 21, 3) - 0.5) * 0.7);
				if (m < BAYER[(y + 1) & 3]![(x + 2) & 3]!) continue;
				img.data[(y * cw + x) * 4 + 3] = alpha;
				liveRows[y] = 1;
			}
		}
		g.putImageData(img, 0, 0);
		return c;
	}

	function bakeField(k0: number, tod: Tod): OffscreenCanvas {
		const pal = SKIES[tod];
		const fw = cw + MARGIN;
		const c = canvas(fw, ch);
		const g = ctx2d(c, true);
		const img = g.createImageData(fw, ch);
		for (let y = 0; y < ch; y++) {
			if (!liveRows[y]) continue;
			const py = y * CELL;
			const v = py / H;
			for (let x = 0; x < fw; x++) {
				const px = x * CELL;
				const u = Math.min(px, W) / W;
				const side = Math.pow(Math.abs(u - 0.5) * 2, 1.6);
				let d = fbm(((x + k0) * CELL) / 260, py / 120, seed, 5);
				d += side * 0.32 - 0.18 + (1 - v) * 0.05;
				const cloud = smooth(0.38, 0.62, d);
				const lit = smooth(
					0.45,
					0.8,
					fbm(px / 90 + 3, py / 60, seed + 9, 3) + (0.4 - v) * 0.6,
				);
				const val = clamp(lerp(lerp(0, 1, v * 1.4), lerp(2, 3, lit), cloud), 0, 2.999);
				const thr = BAYER[y & 3]![x & 3]!;
				const base = Math.floor(val);
				const k = val - base > thr ? base + 1 : base;
				const col =
					k === 0
						? pal.sky[0]
						: k === 1
							? pal.sky[1]
							: k === 2
								? pal.cloud[0]
								: pal.cloud[1];
				const i = (y * fw + x) * 4;
				img.data[i] = col[0];
				img.data[i + 1] = col[1];
				img.data[i + 2] = col[2];
				img.data[i + 3] = 255;
			}
		}
		g.putImageData(img, 0, 0);
		return c;
	}

	return {
		maskPlate,
		bake() {
			drawnK = null;
		},
		// The field lives on the still plate and is redrawn there when it moves.
		step(t0, _dyn, dyn) {
			const tod = timeOfDay(scene.dark, new Date(t0 || Date.now()).getHours());
			const k = scene.motion ? Math.floor(t0 / DRIFT_MS) : 0;
			if (field === null || tod !== fieldTod || k - fieldK0 > MARGIN || k < fieldK0) {
				field = bakeField(k, tod);
				fieldK0 = k;
				fieldTod = tod;
			}
			if (drawnK === k && drawnTod === tod) return [];
			drawnK = k;
			drawnTod = tod;
			dyn.clearRect(0, 0, cw, ch);
			dyn.imageSmoothingEnabled = false;
			dyn.drawImage(field, -(k - fieldK0), 0);
			if (tod === "night") {
				const R = rng("stars/" + scene.seed);
				dyn.fillStyle = "rgb(230,234,255)";
				for (let n = 0; n < (cw * ch) / 2400; n++) {
					const x = (R() * cw) | 0;
					const y = (R() * ch * 0.6) | 0;
					if (mask.at(x * CELL, y * CELL) < 0.6) continue;
					const s = R();
					dyn.globalAlpha = Math.min(1, (top * 0.35 * (0.6 + 0.4 * s)) / A);
					dyn.fillRect(x, y, 1, 1);
				}
				dyn.globalAlpha = 1;
			}
			return "all";
		},
	};
}

export const weather: ThemeDef = {
	id: "weather",
	maxAlpha: MAX_ALPHA,
	pad: 28,
	ramp: 140,
	shape: (u, v) => 1 - smooth(0.28, 0.7, v - 0.25 * Math.pow(Math.abs(u - 0.5) * 2, 2)),
	stepMs: 5000,
	scale: () => 1 / CELL,
	pixelated: true,
	cpuBake: false,
	movers: "plate",
	bakeReadsMask: true,
	create,
};
