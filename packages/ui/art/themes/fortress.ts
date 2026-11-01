// Fortress, after Dwarf Fortress classic (design lane art/worlds/fortress.js).
// A fixed fortress of 128 by 80 cells of 12 px, in the sixteen-colour
// palette, centred on the ground at one art pixel per CSS pixel (the spec's
// engine form; the sheet baked at device scale). Glyphs come from a 1-bit
// atlas made once; the still fortress is baked once per mode, opaque, so the
// ceiling rides the mask plate. A step draws the workshops, a few lava and
// river cells, the seven dwarves and the caravan.

import { pixRng } from "../noise";
import { canvas, ctx2d } from "../pix";
import type { ArtScene, Box, ThemeDef, ThemeInstance } from "./types";

const CELL = 12;
const C = 128;
const R = 80;

type Ink =
	| "black"
	| "blue"
	| "green"
	| "cyan"
	| "red"
	| "magenta"
	| "brown"
	| "lgray"
	| "dgray"
	| "lblue"
	| "lgreen"
	| "lcyan"
	| "lred"
	| "lmagenta"
	| "yellow"
	| "white";

const P: Readonly<Record<Ink, readonly [number, number, number]>> = {
	black: [0, 0, 0],
	blue: [0, 0, 170],
	green: [0, 150, 0],
	cyan: [0, 160, 160],
	red: [170, 0, 0],
	magenta: [170, 0, 170],
	brown: [150, 130, 0],
	lgray: [192, 192, 192],
	dgray: [110, 110, 110],
	lblue: [80, 80, 255],
	lgreen: [70, 230, 70],
	lcyan: [80, 240, 240],
	lred: [255, 70, 70],
	lmagenta: [255, 80, 255],
	yellow: [250, 240, 70],
	white: [255, 255, 255],
};

function ink(name: Ink, dark: boolean): readonly [number, number, number] {
	if (dark) return P[name];
	if (name === "white" || name === "lgray") return [40, 40, 40];
	if (name === "yellow") return [150, 130, 0];
	if (name === "lcyan") return [0, 130, 140];
	if (name === "lgreen") return [20, 140, 30];
	return P[name];
}

// ---- the atlas ----
const BOX = "═║╔╗╚╝╠╣╦╩╬─│┌┐└┘┼├┤┬┴╥╨╤╧╓╙╖╜";
// sides reached [up, right, down, left], and which axes are doubled [vertical, horizontal]
const BOX_SIDES: Readonly<Record<string, readonly number[]>> = {
	"═": [0, 1, 0, 1, 0, 1],
	"║": [1, 0, 1, 0, 1, 0],
	"╔": [0, 1, 1, 0, 1, 1],
	"╗": [0, 0, 1, 1, 1, 1],
	"╚": [1, 1, 0, 0, 1, 1],
	"╝": [1, 0, 0, 1, 1, 1],
	"╠": [1, 1, 1, 0, 1, 1],
	"╣": [1, 0, 1, 1, 1, 1],
	"╦": [0, 1, 1, 1, 1, 1],
	"╩": [1, 1, 0, 1, 1, 1],
	"╬": [1, 1, 1, 1, 1, 1],
	"─": [0, 1, 0, 1, 0, 0],
	"│": [1, 0, 1, 0, 0, 0],
	"┌": [0, 1, 1, 0, 0, 0],
	"┐": [0, 0, 1, 1, 0, 0],
	"└": [1, 1, 0, 0, 0, 0],
	"┘": [1, 0, 0, 1, 0, 0],
	"┼": [1, 1, 1, 1, 0, 0],
	"├": [1, 1, 1, 0, 0, 0],
	"┤": [1, 0, 1, 1, 0, 0],
	"┬": [0, 1, 1, 1, 0, 0],
	"┴": [1, 1, 0, 1, 0, 0],
	"╥": [0, 1, 1, 1, 1, 0],
	"╨": [1, 1, 0, 1, 1, 0],
	"╤": [0, 1, 1, 1, 0, 1],
	"╧": [1, 1, 0, 1, 0, 1],
	"╓": [0, 1, 1, 0, 1, 0],
	"╙": [1, 1, 0, 0, 1, 0],
	"╖": [0, 0, 1, 1, 1, 0],
	"╜": [1, 0, 0, 1, 1, 0],
};

function boxMask(ch: string, n: number): OffscreenCanvas {
	const c = canvas(n, n);
	const g = ctx2d(c);
	g.fillStyle = "#fff";
	const m = Math.floor(n / 2);
	const w = Math.max(1, Math.round(n / 12));
	const gap = Math.max(2, Math.round(n / 6));
	const S = BOX_SIDES[ch] ?? [0, 0, 0, 0, 0, 0];
	const vOff = S[4] ? [-gap / 2, gap / 2] : [0];
	const hOff = S[5] ? [-gap / 2, gap / 2] : [0];
	for (const o of hOff) {
		const a = Math.round(m + o - w / 2);
		if (S[1] || S[3]) g.fillRect(S[3] ? 0 : m, a, (S[1] ? n : m + w) - (S[3] ? 0 : m), w);
	}
	for (const o of vOff) {
		const a = Math.round(m + o - w / 2);
		if (S[0] || S[2]) g.fillRect(a, S[0] ? 0 : m, w, (S[2] ? n : m + w) - (S[0] ? 0 : m));
	}
	return c;
}

function shadeMask(level: number, n: number): OffscreenCanvas {
	const c = canvas(n, n);
	const g = ctx2d(c);
	g.fillStyle = "#fff";
	const p = Math.max(1, Math.round(n / 12));
	for (let y = 0; y < n; y += p) {
		for (let x = 0; x < n; x += p) {
			const i = (x / p) & 1;
			const j = (y / p) & 1;
			const on =
				level === 1
					? i === 0 && j === 0
					: level === 2
						? (i ^ j) === 1
						: !(i === 1 && j === 1);
			if (on) g.fillRect(x, y, p, p);
		}
	}
	return c;
}

const masks = new Map<string, OffscreenCanvas>();
const tinted = new Map<string, OffscreenCanvas>();

function glyphMask(ch: string, n: number): OffscreenCanvas {
	const key = ch + "|" + n;
	const hit = masks.get(key);
	if (hit !== undefined) return hit;
	let c: OffscreenCanvas;
	if (BOX.includes(ch)) c = boxMask(ch, n);
	else if ("░▒▓".includes(ch)) c = shadeMask("░▒▓".indexOf(ch) + 1, n);
	else if (ch === "█") {
		c = canvas(n, n);
		const g = ctx2d(c);
		g.fillStyle = "#fff";
		g.fillRect(0, 0, n, n);
	} else {
		// Letters and symbols are thresholded from the monospace face to one
		// bit. The threshold reads this tiny glyph canvas once, on the CPU.
		c = canvas(n, n);
		const g = ctx2d(c, true);
		g.fillStyle = "#fff";
		g.textAlign = "center";
		g.textBaseline = "middle";
		g.font = `bold ${Math.round(n * 0.95)}px Menlo, "SF Mono", ui-monospace, monospace`;
		g.fillText(ch, n / 2, n / 2 + n * 0.04);
		const img = g.getImageData(0, 0, n, n);
		const d = img.data;
		for (let i = 3; i < d.length; i += 4) {
			const on = (d[i] ?? 0) > 100;
			d[i - 3] = 255;
			d[i - 2] = 255;
			d[i - 1] = 255;
			d[i] = on ? 255 : 0;
		}
		g.putImageData(img, 0, 0);
	}
	masks.set(key, c);
	return c;
}

function tile(ch: string, n: number, rgb: readonly number[]): OffscreenCanvas {
	const key = ch + "|" + n + "|" + rgb.join(",");
	const hit = tinted.get(key);
	if (hit !== undefined) return hit;
	const c = canvas(n, n);
	const g = ctx2d(c);
	g.drawImage(glyphMask(ch, n), 0, 0);
	g.globalCompositeOperation = "source-in";
	g.fillStyle = `rgb(${rgb.join(",")})`;
	g.fillRect(0, 0, n, n);
	tinted.set(key, c);
	return c;
}

// ---- the fortress, laid by hand ----
type Cell = readonly [string, Ink, Ink | null];
interface Fortress {
	readonly M: Map<string, Cell>;
	readonly shops: [number, number][];
}

function build(seed: string): Fortress {
	const M = new Map<string, Cell>();
	const R0 = pixRng("fortress/" + seed);
	const put = (c: number, r: number, ch: string, fg: Ink, bg?: Ink) => {
		if (c >= 0 && r >= 0 && c < C && r < R) M.set(c + "," + r, [ch, fg, bg ?? null]);
	};
	const get = (c: number, r: number) => M.get(c + "," + r);
	const pick = <X>(a: readonly X[]): X => a[Math.floor(R0() * a.length)]!;
	for (let r = 0; r < R; r++) {
		for (let c = 0; c < C; c++) {
			const above =
				r < 20 + Math.round(3 * Math.sin(c / 9)) ||
				c > 104 + Math.round(3 * Math.sin(r / 7));
			if (!above) continue;
			const v = R0();
			if (v < 0.42)
				put(
					c,
					r,
					pick([".", ",", "`", "'", '"', "."]),
					pick<Ink>(["green", "green", "lgreen", "brown"]),
				);
			else if (v < 0.47) put(c, r, pick(["♠", "τ", "♣"]), pick<Ink>(["green", "lgreen"]));
			else if (v < 0.49) put(c, r, "*", pick<Ink>(["lmagenta", "yellow", "lred", "white"]));
		}
	}
	const tree = (cx: number, cy: number, col: Ink) => {
		for (let y = -2; y <= 2; y++) {
			for (let x = -3; x <= 3; x++) {
				if (Math.hypot(x / 3, y / 2) < 1 + (R0() - 0.5) * 0.3) {
					put(
						cx + x,
						cy + y,
						pick(["♣", "♠", "¥", "τ", "♣"]),
						R0() < 0.25 ? "white" : col,
					);
				}
			}
		}
		put(cx, cy + 2, "O", "brown");
	};
	for (const [c, r, col] of [
		[8, 4, "lgreen"],
		[22, 9, "green"],
		[40, 3, "lgreen"],
		[60, 6, "green"],
		[78, 4, "lgreen"],
		[96, 9, "green"],
		[112, 4, "yellow"],
		[118, 26, "lgreen"],
		[110, 42, "green"],
		[116, 58, "lgreen"],
		[109, 72, "green"],
		[30, 14, "lmagenta"],
		[70, 15, "white"],
	] as const)
		tree(c, r, col);
	for (let r = 0; r < R; r++) {
		const x = 122 + Math.round(2 * Math.sin(r / 6));
		for (let k = 0; k < 3; k++)
			put(x + k, r, pick(["≈", "~", "≈"]), pick<Ink>(["blue", "lblue", "cyan"]), "blue");
	}
	for (let r = 18; r < R; r++) {
		for (let c = 0; c < 106; c++) {
			if (get(c, r)) continue;
			put(c, r, R0() < 0.85 ? "░" : pick(["▒", "%", "°"]), R0() < 0.85 ? "dgray" : "brown");
		}
	}
	for (let r = 24; r < R; r++) {
		for (let c = 0; c < 18; c++) {
			if (Math.hypot((c - 2) / 15, (r - 58) / 30) > 1 + (R0() - 0.5) * 0.2) continue;
			put(c, r, pick(["≈", "~", "≈", " "]), pick<Ink>(["yellow", "lred", "red"]), "red");
		}
	}
	const room = (c0: number, r0: number, c1: number, r1: number, wall: Ink = "brown") => {
		for (let r = r0; r <= r1; r++) {
			for (let c = c0; c <= c1; c++) {
				const edge = r === r0 || r === r1 || c === c0 || c === c1;
				if (!edge) {
					put(c, r, R0() < 0.15 ? "·" : " ", "dgray");
					continue;
				}
				const ch =
					r === r0 && c === c0
						? "╔"
						: r === r0 && c === c1
							? "╗"
							: r === r1 && c === c0
								? "╚"
								: r === r1 && c === c1
									? "╝"
									: r === r0 || r === r1
										? "═"
										: "║";
				put(c, r, ch, wall);
			}
		}
	};
	const corridor = (pts: readonly (readonly [number, number])[]) => {
		for (let i = 0; i < pts.length - 1; i++) {
			const [c0, r0] = pts[i]!;
			const [c1, r1] = pts[i + 1]!;
			const n = Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0));
			for (let s = 0; s <= n; s++) {
				put(
					c0 + Math.sign(c1 - c0) * s,
					r0 + Math.sign(r1 - r0) * s,
					R0() < 0.3 ? "·" : " ",
					"dgray",
				);
			}
		}
	};
	const door = (c: number, r: number) => put(c, r, "◘", "brown");
	corridor([
		[60, 21],
		[60, 30],
	]);
	put(60, 22, "+", "lgray");
	put(60, 21, "▼", "lgray");
	corridor([
		[24, 32],
		[96, 32],
	]);
	corridor([
		[24, 33],
		[96, 33],
	]);
	corridor([
		[24, 32],
		[24, 72],
	]);
	corridor([
		[96, 32],
		[96, 72],
	]);
	corridor([
		[24, 72],
		[96, 72],
	]);
	room(28, 36, 50, 48);
	door(39, 36);
	for (let r = 38; r <= 46; r += 2) {
		for (let c = 30; c <= 48; c++) {
			if (c % 6 !== 5)
				put(c, r, c % 3 ? "≡" : "╧", pick<Ink>(["lcyan", "cyan", "white", "lgray"]));
		}
	}
	put(39, 47, "Ω", "white");
	room(54, 36, 76, 48);
	door(65, 36);
	for (let r = 38; r <= 46; r += 2) {
		for (let c = 56; c <= 74; c += 3) {
			put(c, r, "╥", "brown");
			put(c - 1, r, "╓", "brown");
			put(c + 1, r, "╖", "brown");
		}
	}
	put(65, 42, "O", "lblue");
	room(80, 36, 102, 54);
	door(91, 36);
	const shops: [number, number][] = [];
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) {
			const c = 82 + i * 7;
			const r = 38 + j * 5;
			if (c + 3 > 101 || r + 3 > 53) continue;
			shops.push([c, r]);
		}
	}
	for (let i = 0; i < 8; i++) {
		const c0 = 28 + i * 6;
		room(c0, 52, c0 + 5, 57, "brown");
		door(c0 + 2, 52);
		put(c0 + 2, 55, "Θ", pick<Ink>(["lblue", "lred", "lgreen", "yellow", "lmagenta", "lcyan"]));
		put(c0 + 4, 54, "■", "brown");
	}
	room(28, 60, 70, 69);
	door(49, 60);
	for (let r = 61; r <= 68; r++) {
		for (let c = 29; c <= 69; c++) {
			if (R0() < 0.72) {
				put(
					c,
					r,
					pick(["0", "■", "≡", "Φ", "•", "÷", "[", "↑"]),
					pick<Ink>([
						"brown",
						"brown",
						"lgray",
						"yellow",
						"lcyan",
						"lgreen",
						"lred",
						"white",
						"magenta",
					]),
				);
			}
		}
	}
	room(66, 22, 76, 28, "lgray");
	door(71, 28);
	for (let r = 23; r <= 27; r++)
		for (let c = 67; c <= 75; c++) put(c, r, (c + r) % 2 ? "+" : "╬", "brown");
	for (let c = 18; c < 74; c++) {
		const r = 75 + Math.round(Math.sin(c / 5));
		put(c, r, pick(["≈", "~"]), pick<Ink>(["yellow", "lred"]), "red");
		put(c, r + 1, pick(["≈", "~", " "]), "lred", "red");
	}
	for (const [c, r] of [
		[24, 32],
		[96, 32],
		[24, 72],
		[96, 72],
	] as const)
		put(c, r, "X", "lgray");
	for (const [c, r] of [
		[45, 33],
		[75, 33],
		[52, 70],
	] as const)
		put(c, r, "Ω", "white");
	return { M, shops };
}

const FORTS = new Map<string, Fortress>();
const BAKES = new Map<string, OffscreenCanvas>();

function fortress(seed: string): Fortress {
	let f = FORTS.get(seed);
	if (f === undefined) {
		f = build(seed);
		FORTS.set(seed, f);
	}
	return f;
}

/**
 * The still fortress, opaque. The sheet laid a 55 percent black wash and
 * translucent cell grounds and then clamped every pixel to the ceiling, so on
 * the field every pixel ended at the ceiling anyway; baking the same inks
 * opaque gives that result with the ceiling on the mask plate instead.
 */
function bakeFortress(seed: string, dark: boolean): OffscreenCanvas {
	const key = seed + "|" + dark;
	const hit = BAKES.get(key);
	if (hit !== undefined) return hit;
	const F = fortress(seed);
	const n = CELL;
	const b = canvas(C * n, R * n);
	const g = ctx2d(b);
	if (dark) {
		g.fillStyle = "#000";
		g.fillRect(0, 0, C * n, R * n);
	}
	for (const [k, [ch, fg, bg]] of F.M) {
		const i = k.indexOf(",");
		const c = +k.slice(0, i);
		const r = +k.slice(i + 1);
		if (bg !== null) {
			g.fillStyle = `rgb(${ink(bg, dark).join(",")})`;
			g.fillRect(c * n, r * n, n, n);
		}
		if (ch !== " ") g.drawImage(tile(ch, n, ink(fg, dark)), c * n, r * n);
	}
	BAKES.set(key, b);
	return b;
}

const SHOP = [
	["☼", "≡", "☼"],
	["*", "☺", "*"],
	["╬", "≡", "╬"],
] as const;
const ROUNDS: readonly (readonly (readonly [number, number])[])[] = [
	[
		[60, 22],
		[60, 32],
		[39, 32],
		[39, 37],
	],
	[
		[30, 33],
		[90, 33],
	],
	[
		[24, 40],
		[24, 70],
	],
	[
		[96, 34],
		[96, 70],
	],
	[
		[30, 72],
		[90, 72],
	],
	[
		[49, 59],
		[49, 33],
		[65, 33],
		[65, 37],
	],
	[
		[71, 29],
		[71, 32],
		[91, 32],
		[91, 37],
	],
];
const DWARF_INKS: readonly Ink[] = [
	"white",
	"lcyan",
	"lgreen",
	"yellow",
	"lmagenta",
	"lred",
	"lblue",
];
const ROUND_TILES = ROUNDS.map((path) => {
	const tiles: [number, number][] = [];
	for (let i = 0; i < path.length - 1; i++) {
		const [c0, r0] = path[i]!;
		const [c1, r1] = path[i + 1]!;
		const nn = Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0));
		for (let s = 0; s < nn; s++)
			tiles.push([c0 + Math.sign(c1 - c0) * s, r0 + Math.sign(r1 - r0) * s]);
	}
	const last = path[path.length - 1]!;
	tiles.push([last[0], last[1]]);
	return tiles;
});

function create(scene: ArtScene): ThemeInstance {
	const dark = scene.dark;
	const n = CELL;
	const ox = Math.round(scene.W / 2 - (C * CELL) / 2);
	const oy = Math.round(scene.H / 2 - (R * CELL) / 2);
	const F = fortress(scene.seed);
	return {
		bake(g) {
			g.imageSmoothingEnabled = false;
			g.drawImage(bakeFortress(scene.seed, dark), ox, oy);
		},
		key: (t) => String(Math.floor(t / 2000)),
		step(t0, g) {
			const t = scene.motion ? t0 : 0;
			const step = Math.floor(t / 2000);
			const boxes: Box[] = [];
			const at = (c: number, r: number, ch: string, fg: Ink, bg: Ink | null) => {
				const x = ox + c * n;
				const y = oy + r * n;
				// As on the sheet: a dark mover cell lays its black ground first.
				const ground = bg ?? (dark ? "black" : null);
				if (ground !== null) {
					g.fillStyle = `rgb(${ink(ground, dark).join(",")})`;
					g.fillRect(x, y, n, n);
				}
				g.drawImage(tile(ch, n, ink(fg, dark)), x, y);
				boxes.push({ x, y, w: n, h: n });
			};
			F.shops.forEach(([c, r], i) => {
				const on = scene.active && (i + step) % 6 !== 0;
				for (let y = 0; y < 3; y++) {
					for (let x = 0; x < 3; x++) {
						const ch = SHOP[y]![x]!;
						if (ch === "☺" && !on) {
							at(c + x, r + y, "·", "dgray", null);
							continue;
						}
						at(
							c + x,
							r + y,
							ch,
							on
								? ch === "☼"
									? "yellow"
									: ch === "☺"
										? "lmagenta"
										: ch === "*"
											? "lred"
											: "lgray"
								: "dgray",
							null,
						);
					}
				}
			});
			const Rl = pixRng("lava/" + scene.seed + "/" + step);
			for (let k = 0; k < 40; k++) {
				const c = Math.floor(Rl() * 18);
				const r = 30 + Math.floor(Rl() * 48);
				const cell = F.M.get(c + "," + r);
				if (cell && cell[2] === "red")
					at(c, r, Rl() < 0.5 ? "≈" : "~", Rl() < 0.5 ? "yellow" : "white", "red");
			}
			for (let k = 0; k < 24; k++) {
				const r = Math.floor(Rl() * R);
				const x = 122 + Math.round(2 * Math.sin(r / 6)) + Math.floor(Rl() * 3);
				at(x, r, Rl() < 0.5 ? "≈" : "~", Rl() < 0.5 ? "lcyan" : "lblue", "blue");
			}
			ROUND_TILES.forEach((tiles, k) => {
				const L = tiles.length;
				const u = (step + k * 11) % (2 * L - 2);
				const idx = u < L ? u : 2 * L - 2 - u;
				const [c, r] = tiles[idx]!;
				at(c, r, "☺", DWARF_INKS[k % DWARF_INKS.length]!, null);
			});
			const ph = t % 300000;
			if (!scene.motion || (ph > 62000 && ph < 210000)) {
				at(72, 20, "≡", "brown", null);
				at(73, 20, "╬", "brown", null);
				at(70, 21, "☻", "white", null);
				at(74, 21, "☻", "lgray", null);
			} else if (ph <= 62000) {
				const x = 104 - Math.floor(ph / 2000);
				at(x, 20, "≡", "brown", null);
				at(x + 1, 20, "╬", "brown", null);
			}
			return boxes;
		},
	};
}

export const fortressTheme: ThemeDef = {
	id: "fortress",
	maxAlpha: [0.185, 0.3],
	pad: 20,
	ramp: 80,
	shape: null,
	stepMs: 2000,
	scale: () => 1,
	pixelated: true,
	cpuBake: false,
	movers: "dyn",
	bakeReadsMask: false,
	create,
};
