// Slope, after SkiFree, with Totman (design lane art/worlds/skifree.js). A
// snowfield the size of the ground at one art pixel per CSS pixel: sprites on
// a jittered grid, placed only where the quiet mask is clear under their whole
// footprint, so the bake is rebuilt with the mask. A step draws the chairs,
// the dog's word, the yeti and Totman taking the gates.

import { pixRng } from "../noise";
import { disc, line, made, px, type Ctx } from "../pix";
import type { ArtScene, Box, ThemeDef, ThemeInstance } from "./types";

const G = {
	pine: "#29b829",
	pineD: "#167a16",
	pineL: "#8ae68a",
	trunk: "#c8a000",
	trunkD: "#7a6000",
	rock: "#8d8d8d",
	rockD: "#4d4d4d",
	rockL: "#c6c6c6",
	mogul: "#b9bec6",
	red: "#e02020",
	blue: "#2030d0",
	white: "#ffffff",
	black: "#1a1a1a",
	dead: "#8a6a3a",
	sign: "#7ad04a",
	signR: "#e8a0a0",
	dog: "#5a5a5a",
	dogD: "#2e2e2e",
	seat: "#e02020",
	yeti: "#d0d0d0",
	yetiD: "#606060",
	rainbow: ["#e02020", "#f08a10", "#f0e020", "#20b020", "#2050e0", "#8030c0"],
} as const;

const FONT: Readonly<Record<string, string>> = {
	S: "111100111001111",
	T: "111010010010010",
	A: "010101111101101",
	R: "110101110101101",
	F: "111100110100100",
	I: "111010010010111",
	N: "101111111111101",
	H: "101101111101101",
	W: "101101101111101",
	O: "111101101101111",
	"!": "010010010000010",
};

function word(g: Ctx, s: string, x: number, y: number, col: string): void {
	for (let i = 0; i < s.length; i++) {
		const f = FONT[s[i] ?? ""];
		if (f === undefined) continue;
		for (let k = 0; k < 15; k++)
			if (f[k] === "1") px(g, x + i * 4 + (k % 3), y + Math.floor(k / 3), col);
	}
}

const SPR = {
	pine: () =>
		made("ski-pine", 24, 32, (g) => {
			for (let y = 0; y < 26; y++) {
				const w = Math.floor(1 + y * 0.42 - (y % 5 === 4 ? 1 : 0));
				for (let x = -w; x <= w; x++) {
					const n = (x * 7 + y * 13) % 5;
					px(
						g,
						12 + x,
						y,
						Math.abs(x) === w
							? G.pineD
							: n === 0
								? G.pineD
								: n === 1
									? G.pineL
									: G.pine,
					);
				}
			}
			g.fillStyle = G.trunk;
			g.fillRect(10, 26, 4, 5);
			g.fillStyle = G.trunkD;
			g.fillRect(13, 26, 1, 5);
		}),
	small: () =>
		made("ski-small", 14, 19, (g) => {
			for (let y = 0; y < 15; y++) {
				const w = Math.floor(1 + y * 0.38);
				for (let x = -w; x <= w; x++) {
					const n = (x * 5 + y * 11) % 4;
					px(
						g,
						7 + x,
						y,
						Math.abs(x) === w || n === 0 ? G.pineD : n === 1 ? G.pineL : G.pine,
					);
				}
			}
			g.fillStyle = G.trunk;
			g.fillRect(6, 15, 2, 3);
		}),
	dead: () =>
		made("ski-dead", 13, 17, (g) => {
			line(g, 6, 16, 6, 2, G.dead);
			line(g, 6, 6, 2, 2, G.dead);
			line(g, 6, 8, 11, 3, G.dead);
			line(g, 6, 11, 2, 8, G.dead);
			line(g, 6, 12, 10, 9, G.dead);
			line(g, 2, 2, 1, 0, G.dead);
			line(g, 11, 3, 12, 1, G.dead);
		}),
	rock: () =>
		made("ski-rock", 16, 8, (g) => {
			g.fillStyle = G.rockD;
			g.fillRect(2, 2, 12, 6);
			g.fillRect(4, 1, 8, 1);
			g.fillRect(1, 4, 14, 4);
			g.fillStyle = G.rock;
			g.fillRect(3, 3, 10, 4);
			g.fillRect(5, 2, 6, 1);
			g.fillStyle = G.rockL;
			g.fillRect(5, 3, 3, 1);
			g.fillRect(9, 4, 2, 1);
		}),
	mogul: () =>
		made("ski-mogul", 14, 5, (g) => {
			for (let x = 0; x < 14; x++)
				px(g, x, Math.round(4 - Math.sin((x / 13) * Math.PI) * 4), G.mogul);
		}),
	flag: (col: string, dir: number) =>
		made("ski-flag-" + col + dir, 9, 15, (g) => {
			g.fillStyle = G.black;
			g.fillRect(1, 0, 1, 15);
			g.fillStyle = col;
			g.fillRect(2, 1, 7, 6);
			g.fillStyle = G.white;
			if (dir > 0) {
				g.fillRect(3, 4, 4, 1);
				g.fillRect(5, 3, 1, 3);
				px(g, 6, 4, G.white);
			} else {
				g.fillRect(4, 4, 4, 1);
				g.fillRect(5, 3, 1, 3);
				px(g, 3, 4, G.white);
			}
		}),
	rainbow: () =>
		made("ski-rainbow", 26, 6, (g) => {
			G.rainbow.forEach((c, i) => {
				g.fillStyle = c;
				g.fillRect(0, i, 26, 1);
			});
		}),
	sign: (txt: string, col: string) =>
		made("ski-sign-" + txt, txt.length * 4 + 7, 20, (g) => {
			g.fillStyle = G.black;
			g.fillRect(txt.length * 4 + 3, 0, 1, 20);
			g.fillStyle = col;
			g.fillRect(0, 2, txt.length * 4 + 3, 8);
			g.fillStyle = G.black;
			g.fillRect(0, 2, txt.length * 4 + 3, 1);
			g.fillRect(0, 9, txt.length * 4 + 3, 1);
			word(g, txt, 2, 4, G.black);
		}),
	pylon: () =>
		made("ski-pylon", 16, 46, (g) => {
			g.fillStyle = G.black;
			g.fillRect(7, 6, 3, 38);
			g.fillRect(1, 2, 14, 2);
			g.fillRect(1, 2, 1, 5);
			g.fillRect(14, 2, 1, 5);
			g.fillStyle = "#c8a000";
			g.fillRect(6, 40, 5, 6);
			g.fillStyle = "#e6c84a";
			g.fillRect(7, 41, 3, 4);
			g.fillStyle = "#e0b040";
			g.fillRect(7, 14, 3, 3);
		}),
	chair: (riders: number) =>
		made("ski-chair-" + riders, 14, 16, (g) => {
			g.fillStyle = G.black;
			g.fillRect(6, 0, 1, 7);
			g.fillStyle = G.seat;
			g.fillRect(0, 7, 14, 5);
			g.fillStyle = "#9a1010";
			g.fillRect(0, 11, 14, 1);
			if (riders) {
				g.fillStyle = "#30c0c0";
				g.fillRect(2, 2, 3, 3);
				g.fillStyle = "#e05050";
				g.fillRect(2, 5, 3, 3);
				g.fillStyle = "#40c040";
				g.fillRect(9, 2, 3, 3);
				g.fillStyle = "#3040d0";
				g.fillRect(9, 5, 3, 3);
				g.fillStyle = "#e0e0e0";
				g.fillRect(2, 12, 1, 4);
				g.fillRect(10, 12, 1, 4);
			}
		}),
	dog: () =>
		made("ski-dog", 15, 10, (g) => {
			g.fillStyle = G.dog;
			g.fillRect(3, 3, 9, 4);
			g.fillRect(10, 1, 4, 4);
			g.fillRect(3, 7, 2, 3);
			g.fillRect(9, 7, 2, 3);
			g.fillRect(0, 2, 3, 2);
			g.fillStyle = G.dogD;
			g.fillRect(11, 0, 1, 2);
			g.fillRect(13, 2, 1, 1);
			g.fillRect(14, 3, 1, 1);
		}),
	yeti: () =>
		made("ski-yeti", 18, 22, (g) => {
			disc(g, 9, 9, 6, G.yeti);
			g.fillStyle = G.yeti;
			g.fillRect(5, 3, 8, 3);
			g.fillStyle = G.yetiD;
			g.fillRect(6, 6, 2, 1);
			g.fillRect(10, 6, 2, 1);
			g.fillRect(7, 10, 4, 2);
			line(g, 3, 8, 0, 3, G.yetiD);
			line(g, 15, 8, 17, 3, G.yetiD);
			line(g, 7, 15, 5, 21, G.yetiD);
			line(g, 11, 15, 13, 21, G.yetiD);
		}),
	woof: () => made("ski-woof", 21, 6, (g) => word(g, "WOOF!", 0, 0, G.black)),
};

/** Totman on skis: the 20 px cut of the real art, skis and poles under him. */
function totmanSki(doll: CanvasImageSource | null, dir: number): OffscreenCanvas {
	return made("ski-totman-" + dir + (doll === null ? "-bare" : ""), 26, 26, (g) => {
		if (doll !== null) {
			g.save();
			if (dir < 0) {
				g.translate(26, 0);
				g.scale(-1, 1);
			}
			g.drawImage(doll, 0, 0);
			g.restore();
		}
		line(g, 4, 23 - dir, 20, 23 + dir, "#c02020");
		line(g, 6, 25 - dir, 22, 25 + dir, "#c02020");
		line(g, 3, 14, 2, 24, G.black);
		line(g, 23, 14, 24, 24, G.black);
	});
}

interface Placed {
	x: number;
	y: number;
	w: number;
	h: number;
}

function create(scene: ArtScene): ThemeInstance {
	const { W, H, mask } = scene;
	// The placement is seeded and reads the mask, so it is decided once per
	// bake; the movers reuse it.
	let pylons: [number, number][] = [];
	let gates: [number, number][] = [];
	let dogAt: [number, number] | null = null;
	let home: [number, number] | null = null;
	return {
		bake(g) {
			g.imageSmoothingEnabled = false;
			const R0 = pixRng("slope/" + scene.seed);
			const placed: Placed[] = [];
			const fits = (x: number, y: number, w: number, h: number) => {
				for (let yy = y; yy <= y + h; yy += 6) {
					for (let xx = x; xx <= x + w; xx += 6) if (mask.at(xx, yy) < 0.85) return false;
				}
				return !placed.some(
					(p) =>
						x < p.x + p.w + 14 &&
						x + w + 14 > p.x &&
						y < p.y + p.h + 14 &&
						y + h + 14 > p.y,
				);
			};
			const place = (spr: OffscreenCanvas, x: number, y: number) => {
				if (!fits(x, y, spr.width, spr.height)) return false;
				placed.push({ x, y, w: spr.width, h: spr.height });
				g.drawImage(spr, Math.round(x), Math.round(y));
				return true;
			};
			const lx = Math.round(W * 0.78);
			pylons = [];
			for (let y = H - 60; y > -40; y -= 210) {
				const x = lx + Math.round((H - y) * 0.12);
				if (fits(x, y, 16, 46)) {
					pylons.push([x, y]);
					placed.push({ x, y, w: 16, h: 46 });
				}
			}
			if (pylons.length > 1) {
				g.strokeStyle = "#555";
				g.lineWidth = 1;
				for (let i = 0; i < pylons.length - 1; i++) {
					const [x0, y0] = pylons[i]!;
					const [x1, y1] = pylons[i + 1]!;
					for (const off of [2, 14]) {
						g.beginPath();
						g.moveTo(x0 + off, y0 + 3);
						g.lineTo(x1 + off, y1 + 3);
						g.stroke();
					}
				}
				for (const [x, y] of pylons) g.drawImage(SPR.pylon(), x, y);
			}
			if (!place(SPR.sign("START", G.sign), Math.round(W * 0.42), 24)) {
				place(SPR.sign("START", G.sign), Math.round(W * 0.6), 40);
			}
			place(SPR.sign("FINISH", G.signR), Math.round(W * 0.35), H - 40);
			gates = [];
			for (let y = 90, k = 0; y < H - 80; y += 95, k++) {
				const x = Math.round(W * 0.48 + (k % 2 ? 50 : -50) + (R0() - 0.5) * 20);
				if (place(SPR.flag(k % 2 ? G.blue : G.red, k % 2 ? 1 : -1), x, y))
					gates.push([x + 4, y + 15]);
			}
			const cell = 120;
			for (let gy = 0; gy < H; gy += cell) {
				for (let gx = 0; gx < W; gx += cell) {
					const v = R0();
					if (v > 0.55) continue;
					const x = gx + R0() * (cell - 30);
					const y = gy + R0() * (cell - 34);
					const spr =
						v < 0.22
							? SPR.pine()
							: v < 0.36
								? SPR.small()
								: v < 0.45
									? SPR.rock()
									: v < 0.55
										? SPR.mogul()
										: v < 0.59
											? SPR.dead()
											: SPR.rainbow();
					place(spr, Math.round(x), Math.round(y));
				}
			}
			dogAt = null;
			for (let k = 0; k < 30 && dogAt === null; k++) {
				const x = Math.round(W * (0.15 + R0() * 0.3));
				const y = Math.round(H * (0.45 + R0() * 0.4));
				if (place(SPR.dog(), x, y)) dogAt = [x, y];
			}
			home = null;
			for (let k = 0; k < 20 && home === null; k++) {
				const x = Math.round(W * (0.05 + R0() * 0.15));
				const y = Math.round(H * (0.75 + R0() * 0.2));
				if (fits(x, y, 18, 22)) home = [x, y];
			}
		},
		// Chairs, Totman and the dog move on two seconds, the yeti on four.
		key: (t) => String(Math.floor(t / 2000)),
		step(t0, g) {
			const t = scene.motion ? t0 : 0;
			const minute = Math.floor(t / 60000);
			const boxes: Box[] = [];
			const blit = (spr: OffscreenCanvas, x: number, y: number) => {
				const bx = Math.round(x);
				const by = Math.round(y);
				g.drawImage(spr, bx, by);
				boxes.push({ x: bx, y: by, w: spr.width, h: spr.height });
			};
			g.imageSmoothingEnabled = false;
			if (pylons.length > 1) {
				const [xa, ya] = pylons[0]!;
				const [xb, yb] = pylons[pylons.length - 1]!;
				const L = Math.hypot(xb - xa, yb - ya);
				const nChairs = Math.max(2, Math.floor(L / 110));
				for (let k = 0; k < nChairs; k++) {
					// a chair moves 2 px every two seconds
					const s =
						((k * 110 + Math.floor(t / 2000) * 2) % (nChairs * 110)) / (nChairs * 110);
					blit(
						SPR.chair(k % 3 !== 0 ? 1 : 0),
						xa + 14 + (xb - xa) * s - 6,
						ya + 3 + (yb - ya) * s,
					);
					blit(SPR.chair(0), xb + 2 + (xa - xb) * s - 6, yb + 3 + (ya - yb) * s);
				}
			}
			if (
				dogAt !== null &&
				scene.motion &&
				minute % 7 === 3 &&
				Math.floor(t / 20000) % 3 === 0
			) {
				blit(SPR.woof(), dogAt[0] - 3, dogAt[1] - 9);
			}
			if (home !== null) {
				const cyc = t % 1200000;
				const out = cyc < 600000 ? cyc : 1200000 - cyc;
				const n = scene.motion ? Math.floor(out / 4000) : 0;
				const x = home[0] + n * 2.4;
				const y = home[1] - n * 3.2;
				if (
					mask.at(x + 9, y + 11) > 0.9 &&
					mask.at(x, y) > 0.9 &&
					mask.at(x + 18, y + 22) > 0.9
				) {
					blit(SPR.yeti(), x, y);
				}
			}
			if (gates.length > 0) {
				const run = 420000;
				const ph = t % run;
				const nRun = Math.floor(t / run);
				const step = Math.floor(ph / 2000);
				const Rr = pixRng("line/" + scene.seed + "/" + nRun);
				const path: [number, number][] = [
					[Math.round(W * 0.48), 50],
					...gates.map(([x, y], i): [number, number] => [
						x + (i % 2 ? -18 : 18) + Math.round((Rr() - 0.5) * 10),
						y + 6,
					]),
					[Math.round(W * 0.4), H + 30],
				];
				let total = 0;
				const seg: number[] = [];
				for (let i = 0; i < path.length - 1; i++) {
					const L = Math.hypot(
						path[i + 1]![0] - path[i]![0],
						path[i + 1]![1] - path[i]![1],
					);
					seg.push(L);
					total += L;
				}
				let s = scene.motion ? Math.min(total, step * 7) : 0;
				// still: he waits at the first clear spot on his line
				if (!scene.motion) {
					let acc = 0;
					for (let k = 0; k < seg.length && !s; k++) {
						const sk = seg[k]!;
						for (let q = 0; q < sk; q += 8) {
							const x = path[k]![0] + (path[k + 1]![0] - path[k]![0]) * (q / sk);
							const y = path[k]![1] + (path[k + 1]![1] - path[k]![1]) * (q / sk);
							if (mask.at(x, y) > 0.9) {
								s = acc + q + 0.001;
								break;
							}
						}
						acc += sk;
					}
				}
				let i = 0;
				while (i < seg.length - 1 && s > seg[i]!) {
					s -= seg[i]!;
					i++;
				}
				const u = Math.min(1, s / seg[i]!);
				const x = path[i]![0] + (path[i + 1]![0] - path[i]![0]) * u;
				const y = path[i]![1] + (path[i + 1]![1] - path[i]![1]) * u;
				const dir = path[i + 1]![0] >= path[i]![0] ? 1 : -1;
				if (scene.totman !== null && y < H + 20 && mask.at(x, y) > 0.6) {
					blit(totmanSki(scene.totman, dir), x - 13, y - 24);
				}
			}
			return boxes;
		},
	};
}

export const slope: ThemeDef = {
	id: "skifree",
	maxAlpha: [0.19, 0.27],
	pad: 20,
	ramp: 60,
	shape: null,
	stepMs: 1000,
	scale: () => 1,
	pixelated: true,
	cpuBake: false,
	movers: "dyn",
	bakeReadsMask: true,
	create,
};
