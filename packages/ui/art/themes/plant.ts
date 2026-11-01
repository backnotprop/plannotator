// Plant, after a Factorio base (design lane art/worlds/plant.js, round 6). A
// fixed world of 96 by 60 tiles of 16 px at one art pixel per CSS pixel,
// centred on the ground. The still world (and the belt chevrons, which never
// change) is baked once per seed; a step draws only what moved: items a tile
// every two seconds, inserter arms and gears on the same step, the agent
// pads and lab lights, furnace fire, smoke, and the train.

import { pixRng } from "../noise";
import { canvas, ctx2d, disc, line, px, ring, word, type Ctx } from "../pix";
import type { ArtScene, Box, ThemeDef, ThemeInstance } from "./types";

const T = 16;
const C = 96;
const R = 60;
const AW = C * T;
const AH = R * T;

const K = {
	ground: "#22252b",
	ground2: "#262930",
	ground3: "#1e2126",
	pad: "#2c2f36",
	padLine: "#31353d",
	padEdge: "#3b3f48",
	label: "#7d8494",
	beltEdge: "#17191d",
	bed: "#4b4f57",
	bed2: "#43474e",
	chev: "#8a909c",
	doc: "#f1efe6",
	docLine: "#7c7a72",
	proto: "#f0943c",
	decision: "#62c46a",
	agent: "#9a9cff",
	itemEdge: "#0f1013",
	plate: "#30333a",
	body: "#6d727c",
	bodyHi: "#9298a3",
	bodyLo: "#4c5058",
	trim: "#3f6fbf",
	trimAgent: "#7a6ee0",
	gearD: "#1c1e22",
	gearL: "#a9aeb8",
	padOff: "#3a3d44",
	padOn: "#5fbf5a",
	dome: "#355bb0",
	domeHi: "#6f93e6",
	domeFrame: "#c3cde6",
	domeLine: "#1a2650",
	domeLit: "#c0ceff",
	insBase: "#2f3238",
	insArm: "#d8b04a",
	insArmF: "#5a8fe0",
	hand: "#17191d",
	pipe: "#4a78a2",
	pipeHi: "#8fb4d6",
	pipeJ: "#2a4762",
	tank: "#5f7f9e",
	poleW: "#6e5238",
	poleD: "#3f2f20",
	wire: "#c9844a",
	chest: "#7b5a36",
	chestBand: "#3f2d1a",
	steel: "#8d939d",
	sleeper: "#4a3e33",
	railSteel: "#a9aeb8",
	loco: "#c0473a",
	locoRoof: "#d6d6d6",
	wagon: "#6d747f",
	stone: "#7b766f",
	stoneLo: "#55514c",
	fire: "#ffae42",
	smoke: "#8a8b90",
	chem: "#4e7a58",
	chemHi: "#6fa077",
} as const;

const FONT: Readonly<Record<string, string>> = {
	A: "010101111101101",
	B: "110101110101110",
	C: "011100100100011",
	D: "110101101101110",
	E: "111100110100111",
	G: "011100101101011",
	I: "111010010010111",
	K: "101101110101101",
	L: "100100100100111",
	M: "101111111101101",
	N: "101111111111101",
	O: "010101101101010",
	S: "011100010001110",
	T: "111010010010010",
	Y: "101101010010010",
	" ": "000000000000000",
};

type ItemKind = "doc" | "proto" | "decision" | "agent";
interface BeltTile {
	readonly c: number;
	readonly r: number;
	readonly dx: number;
	readonly dy: number;
	inx: number;
	iny: number;
}
interface Inserter {
	readonly c: number;
	readonly r: number;
	readonly dir: "h" | "v";
	readonly fast?: boolean;
	readonly purple?: boolean;
}
interface Machine {
	readonly c: number;
	readonly r: number;
	readonly agent: boolean;
	readonly trim: boolean;
}
interface Pad {
	readonly c0: number;
	readonly r0: number;
	readonly c1: number;
	readonly r1: number;
	readonly name: string;
}
interface World {
	readonly belts: { tiles: BeltTile[]; kind: ItemKind }[];
	readonly machines: Machine[];
	readonly domes: { c: number; r: number }[];
	readonly inserters: Inserter[];
	readonly furnaces: [number, number][];
	readonly pipes: [number, number][][];
	readonly tanks: [number, number][];
	readonly chems: [number, number][];
	readonly poles: [number, number][];
	readonly chests: [number, number, boolean][];
	readonly splitters: [number, number][];
	readonly pads: Pad[];
	readonly rail: { top: number; right: number };
}

function build(): World {
	const W: World = {
		belts: [],
		machines: [],
		domes: [],
		inserters: [],
		furnaces: [],
		pipes: [],
		tanks: [],
		chems: [],
		poles: [],
		chests: [],
		splitters: [],
		pads: [],
		rail: { top: 2, right: 92 },
	};
	const belt = (pts: [number, number][], kind: ItemKind) => {
		const tiles: BeltTile[] = [];
		for (let i = 0; i < pts.length - 1; i++) {
			const [c0, r0] = pts[i]!;
			const [c1, r1] = pts[i + 1]!;
			const dx = Math.sign(c1 - c0);
			const dy = Math.sign(r1 - r0);
			const n = Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0));
			for (let s = 0; s < n + (i === pts.length - 2 ? 1 : 0); s++) {
				tiles.push({ c: c0 + dx * s, r: r0 + dy * s, dx, dy, inx: 0, iny: 0 });
			}
		}
		tiles.forEach((t, i) => {
			const p = tiles[i - 1];
			t.inx = p ? p.dx : t.dx;
			t.iny = p ? p.dy : t.dy;
		});
		W.belts.push({ tiles, kind });
	};
	const pad = (c0: number, r0: number, c1: number, r1: number, name: string) =>
		W.pads.push({ c0, r0, c1, r1, name });
	pad(3, 5, 22, 23, "SMELTING");
	pad(25, 5, 56, 23, "ASSEMBLY");
	pad(58, 5, 89, 23, "LABS");
	pad(3, 34, 22, 57, "DATA");
	pad(25, 34, 71, 57, "AGENT BAYS");
	pad(74, 34, 89, 57, "DOCK");
	const lanes: ItemKind[] = ["doc", "doc", "proto", "proto", "decision", "agent"];
	lanes.forEach((k, i) =>
		belt(
			[
				[3, 26 + i],
				[72, 26 + i],
			],
			k,
		),
	);
	for (const c of [24, 57]) for (let i = 0; i < 6; i += 2) W.splitters.push([c, 26 + i]);
	for (const [fl, il, bc, ir, fr] of [
		[4, 6, 7, 8, 9],
		[13, 15, 16, 17, 18],
	] as const) {
		belt(
			[
				[bc, 7],
				[bc, 25],
			],
			"doc",
		);
		for (let r = 7; r <= 20; r += 3) {
			W.furnaces.push([fl, r], [fr, r]);
			W.inserters.push({ c: il, r, dir: "h" }, { c: ir, r, dir: "h" });
		}
	}
	belt(
		[
			[26, 25],
			[26, 8],
			[53, 8],
		],
		"proto",
	);
	belt(
		[
			[27, 15],
			[53, 15],
		],
		"decision",
	);
	belt(
		[
			[27, 13],
			[54, 13],
			[54, 25],
		],
		"doc",
	);
	belt(
		[
			[27, 21],
			[55, 21],
			[55, 25],
		],
		"decision",
	);
	for (const [rM, rOut] of [
		[10, 13],
		[17, 21],
	] as const) {
		for (let c = 28; c + 3 <= 53; c += 4) {
			W.machines.push({ c, r: rM, agent: false, trim: (c / 4) % 3 === 0 });
			W.inserters.push({ c: c + 1, r: rM - 1, dir: "v", fast: false });
			if (rOut - (rM + 3) >= 1)
				W.inserters.push({ c: c + 1, r: rM + 3, dir: "v", fast: true });
		}
	}
	belt(
		[
			[59, 25],
			[59, 11],
			[88, 11],
		],
		"agent",
	);
	belt(
		[
			[60, 17],
			[88, 17],
		],
		"agent",
	);
	for (const r of [7, 12, 18]) {
		for (let c = 61; c + 3 <= 89; c += 5)
			W.domes.push({ c, r: r === 12 ? 13 : r === 18 ? 19 : r });
	}
	for (let c = 62; c < 89; c += 5) {
		W.inserters.push(
			{ c, r: 10, dir: "v", fast: true, purple: true },
			{ c, r: 12, dir: "v", fast: true, purple: true },
			{ c, r: 18, dir: "v", fast: true, purple: true },
		);
	}
	for (const t of [
		[4, 36],
		[10, 36],
		[16, 36],
		[4, 47],
		[10, 47],
		[16, 47],
	] as const)
		W.tanks.push([t[0], t[1]]);
	const pipe = (pts: [number, number][]) => {
		const tiles: [number, number][] = [];
		for (let i = 0; i < pts.length - 1; i++) {
			const [c0, r0] = pts[i]!;
			const [c1, r1] = pts[i + 1]!;
			const dx = Math.sign(c1 - c0);
			const dy = Math.sign(r1 - r0);
			const n = Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0));
			for (let s = 0; s <= n; s++) tiles.push([c0 + dx * s, r0 + dy * s]);
		}
		W.pipes.push(tiles);
	};
	pipe([
		[4, 40],
		[21, 40],
		[21, 33],
	]);
	pipe([
		[4, 51],
		[21, 51],
		[21, 41],
	]);
	for (const c of [5, 11, 17]) {
		pipe([
			[c, 39],
			[c, 40],
		]);
		pipe([
			[c, 50],
			[c, 51],
		]);
	}
	for (const t of [
		[5, 42],
		[12, 42],
		[5, 53],
		[12, 53],
	] as const)
		W.chems.push([t[0], t[1]]);
	pipe([
		[8, 43],
		[8, 41],
	]);
	pipe([
		[15, 43],
		[15, 41],
	]);
	pipe([
		[8, 54],
		[8, 52],
	]);
	pipe([
		[15, 54],
		[15, 52],
	]);
	belt(
		[
			[26, 32],
			[26, 36],
			[70, 36],
		],
		"doc",
	);
	belt(
		[
			[27, 44],
			[70, 44],
		],
		"proto",
	);
	belt(
		[
			[27, 42],
			[70, 42],
		],
		"agent",
	);
	belt(
		[
			[27, 52],
			[70, 52],
		],
		"agent",
	);
	for (const rM of [38, 46]) {
		for (let c = 28; c + 3 <= 70; c += 4) {
			W.machines.push({ c, r: rM, agent: true, trim: true });
			W.inserters.push({ c: c + 1, r: rM - 1, dir: "v", fast: true });
			W.inserters.push({ c: c + 2, r: rM + 3, dir: "v", fast: true });
		}
	}
	belt(
		[
			[73, 26],
			[73, 36],
			[86, 36],
		],
		"doc",
	);
	belt(
		[
			[73, 31],
			[74, 31],
			[74, 34],
			[86, 34],
		],
		"agent",
	);
	for (let r = 38; r <= 56; r++) {
		W.chests.push([86, r, r % 3 === 0], [88, r, r % 2 === 0]);
		if (r % 2 === 0) W.inserters.push({ c: 87, r, dir: "h" });
	}
	for (let c = 76; c <= 84; c += 2)
		for (let r = 39; r <= 55; r += 4) W.chests.push([c, r, (c + r) % 3 === 0]);
	for (const p of W.pads) {
		for (const [c, r] of [
			[p.c1, p.r0],
			[p.c0, p.r1],
			[p.c1, p.r1],
		] as const)
			W.poles.push([c, r]);
	}
	for (let c = 10; c < 72; c += 9) {
		W.poles.push([c, 25]);
		W.poles.push([c, 32]);
	}
	return W;
}

function drawBeltBed(a: Ctx, t: BeltTile): void {
	const x = t.c * T;
	const y = t.r * T;
	const parts: [number, number][] = [
		[t.dx, t.dy],
		[-t.inx, -t.iny],
	];
	a.fillStyle = K.beltEdge;
	a.fillRect(x + 1, y + 1, 14, 14);
	for (const [dx, dy] of parts) {
		if (dx > 0) a.fillRect(x + 8, y + 1, 8, 14);
		if (dx < 0) a.fillRect(x, y + 1, 8, 14);
		if (dy > 0) a.fillRect(x + 1, y + 8, 14, 8);
		if (dy < 0) a.fillRect(x + 1, y, 14, 8);
	}
	a.fillStyle = K.bed;
	a.fillRect(x + 3, y + 3, 10, 10);
	for (const [dx, dy] of parts) {
		if (dx > 0) a.fillRect(x + 8, y + 3, 8, 10);
		if (dx < 0) a.fillRect(x, y + 3, 8, 10);
		if (dy > 0) a.fillRect(x + 3, y + 8, 10, 8);
		if (dy < 0) a.fillRect(x + 3, y, 10, 8);
	}
	a.fillStyle = K.bed2;
	if (t.dx || t.inx)
		a.fillRect(
			x + (t.inx < 0 || (!t.inx && t.dx < 0) ? 0 : 3),
			y + 7,
			t.dx && t.inx ? 16 : 13,
			2,
		);
	if (t.dy || t.iny)
		a.fillRect(
			x + 7,
			y + (t.iny < 0 || (!t.iny && t.dy < 0) ? 0 : 3),
			2,
			t.dy && t.iny ? 16 : 13,
		);
}

function bakeWorld(W: World, seed: string): OffscreenCanvas {
	const cv = canvas(AW, AH);
	const a = ctx2d(cv);
	const R0 = pixRng("plant6-ground/" + seed);
	a.fillStyle = K.ground;
	a.fillRect(0, 0, AW, AH);
	for (let i = 0; i < AW * AH * 0.03; i++)
		px(a, R0() * AW, R0() * AH, R0() < 0.5 ? K.ground2 : K.ground3);
	for (const p of W.pads) {
		const x = p.c0 * T;
		const y = p.r0 * T;
		const w = (p.c1 - p.c0 + 1) * T;
		const h = (p.r1 - p.r0 + 1) * T;
		a.fillStyle = K.pad;
		a.fillRect(x, y, w, h);
		a.fillStyle = K.padLine;
		for (let xx = x; xx < x + w; xx += T) a.fillRect(xx, y, 1, h);
		for (let yy = y; yy < y + h; yy += T) a.fillRect(x, yy, w, 1);
		a.fillStyle = K.padEdge;
		a.fillRect(x, y, w, 1);
		a.fillRect(x, y + h - 1, w, 1);
		a.fillRect(x, y, 1, h);
		a.fillRect(x + w - 1, y, 1, h);
		a.fillStyle = K.pad;
		a.fillRect(x + 3, y - 3, p.name.length * 4 + 3, 7);
		word(a, FONT, p.name, x + 5, y - 2, K.label);
	}
	for (let x = 0; x < W.rail.right * T + 14; x += 4) {
		a.fillStyle = K.sleeper;
		a.fillRect(x, W.rail.top * T + 1, 3, 14);
	}
	for (let y = W.rail.top * T; y < AH; y += 4) {
		a.fillStyle = K.sleeper;
		a.fillRect(W.rail.right * T + 1, y, 14, 3);
	}
	a.fillStyle = K.railSteel;
	a.fillRect(0, W.rail.top * T + 4, W.rail.right * T + 12, 2);
	a.fillRect(0, W.rail.top * T + 10, W.rail.right * T + 5, 2);
	a.fillRect(W.rail.right * T + 4, W.rail.top * T + 10, 2, AH);
	a.fillRect(W.rail.right * T + 10, W.rail.top * T + 4, 2, AH);
	a.fillStyle = K.padEdge;
	a.fillRect(90 * T + 4, 37 * T, 8, 20 * T);
	for (const b of W.belts) for (const t of b.tiles) drawBeltBed(a, t);
	for (const [c, r] of W.splitters) {
		const x = c * T;
		const y = r * T;
		a.fillStyle = K.beltEdge;
		a.fillRect(x + 1, y, 14, 2 * T);
		a.fillStyle = K.plate;
		a.fillRect(x + 3, y + 2, 10, 2 * T - 4);
		a.fillStyle = K.trim;
		a.fillRect(x + 6, y + 6, 4, 2 * T - 12);
		a.fillStyle = K.gearL;
		a.fillRect(x + 4, y + 3, 8, 1);
		a.fillRect(x + 4, y + 2 * T - 4, 8, 1);
	}
	const has = new Set(W.pipes.flat().map(([c, r]) => c + "," + r));
	for (const tiles of W.pipes) {
		for (const [c, r] of tiles) {
			const x = c * T;
			const y = r * T;
			const L = has.has(c - 1 + "," + r);
			const Rr = has.has(c + 1 + "," + r);
			const U = has.has(c + "," + (r - 1));
			const D = has.has(c + "," + (r + 1));
			a.fillStyle = K.pipeJ;
			a.fillRect(x + 4, y + 4, 8, 8);
			if (L) a.fillRect(x, y + 4, 5, 8);
			if (Rr) a.fillRect(x + 11, y + 4, 5, 8);
			if (U) a.fillRect(x + 4, y, 8, 5);
			if (D) a.fillRect(x + 4, y + 11, 8, 5);
			a.fillStyle = K.pipe;
			a.fillRect(x + 5, y + 5, 6, 6);
			if (L) a.fillRect(x, y + 5, 5, 6);
			if (Rr) a.fillRect(x + 11, y + 5, 5, 6);
			if (U) a.fillRect(x + 5, y, 6, 5);
			if (D) a.fillRect(x + 5, y + 11, 6, 5);
			a.fillStyle = K.pipeHi;
			if (L || Rr) a.fillRect(x + (L ? 0 : 5), y + 6, (L ? 5 : 0) + 6 + (Rr ? 5 : 0), 1);
			else a.fillRect(x + 6, y + (U ? 0 : 5), 1, (U ? 5 : 0) + 6 + (D ? 5 : 0));
		}
	}
	for (const [c, r] of W.tanks) {
		const x = c * T + 24;
		const y = r * T + 24;
		disc(a, x, y + 1, 21, "rgba(0,0,0,0.35)");
		disc(a, x, y, 20, K.pipeJ);
		disc(a, x, y, 18, K.tank);
		disc(a, x - 5, y - 5, 7, K.pipeHi);
		ring(a, x, y, 13, K.pipeJ);
	}
	for (const [c, r] of W.chems) {
		const x = c * T;
		const y = r * T;
		a.fillStyle = K.plate;
		a.fillRect(x + 1, y + 1, 46, 46);
		a.fillStyle = K.chem;
		a.fillRect(x + 3, y + 3, 42, 42);
		a.fillStyle = K.chemHi;
		a.fillRect(x + 3, y + 3, 42, 2);
		a.fillRect(x + 3, y + 3, 2, 42);
		disc(a, x + 15, y + 18, 8, K.pipeJ);
		disc(a, x + 15, y + 18, 6, "#cfe2d2");
		disc(a, x + 33, y + 18, 8, K.pipeJ);
		disc(a, x + 33, y + 18, 6, "#e3d9b6");
		a.fillStyle = K.pipe;
		a.fillRect(x + 8, y + 34, 32, 4);
	}
	for (const [c, r] of W.furnaces) {
		const x = c * T;
		const y = r * T;
		a.fillStyle = K.stoneLo;
		a.fillRect(x + 1, y + 1, 30, 30);
		a.fillStyle = K.stone;
		a.fillRect(x + 2, y + 2, 28, 26);
		a.fillStyle = K.stoneLo;
		for (let k = 0; k < 4; k++) a.fillRect(x + 2, y + 7 + k * 6, 28, 1);
		a.fillStyle = "#1c1a18";
		a.fillRect(x + 10, y + 17, 12, 9);
	}
	for (const m of W.machines) {
		const x = m.c * T;
		const y = m.r * T;
		a.fillStyle = "rgba(0,0,0,0.35)";
		a.fillRect(x + 2, y + 3, 46, 46);
		a.fillStyle = K.plate;
		a.fillRect(x + 1, y + 1, 46, 46);
		a.fillStyle = m.agent ? K.trimAgent : m.trim ? K.trim : K.bodyLo;
		a.fillRect(x + 3, y + 3, 42, 42);
		a.fillStyle = K.body;
		a.fillRect(x + 4, y + 4, 40, 34);
		a.fillStyle = K.bodyHi;
		a.fillRect(x + 4, y + 4, 40, 2);
		a.fillRect(x + 4, y + 4, 2, 34);
		a.fillStyle = K.bodyLo;
		a.fillRect(x + 4, y + 36, 40, 2);
		a.fillRect(x + 42, y + 4, 2, 34);
		disc(a, x + 24, y + 20, 11, K.gearD);
		a.fillStyle = K.bodyLo;
		a.fillRect(x + 8, y + 8, 5, 3);
		a.fillRect(x + 35, y + 8, 5, 3);
		a.fillStyle = K.padOff;
		a.fillRect(x + 6, y + 39, 36, 5);
	}
	for (const d of W.domes) {
		const x = d.c * T + 24;
		const y = d.r * T + 24;
		disc(a, x + 1, y + 2, 21, "rgba(0,0,0,0.35)");
		disc(a, x, y, 21, K.domeLine);
		disc(a, x, y, 19, K.dome);
		disc(a, x - 5, y - 6, 8, K.domeHi);
		for (let k = -2; k <= 2; k++)
			line(a, x + k * 7, y - 18, x + k * 7 * 0.6, y + 18, K.domeLine);
		for (const yy of [-10, 0, 10]) line(a, x - 18, y + yy, x + 18, y + yy, K.domeLine);
		ring(a, x, y, 19, K.domeFrame);
	}
	for (const [c, r, steel] of W.chests) {
		const x = c * T;
		const y = r * T;
		a.fillStyle = "#121315";
		a.fillRect(x + 3, y + 4, 11, 10);
		a.fillStyle = steel ? K.steel : K.chest;
		a.fillRect(x + 2, y + 3, 11, 10);
		a.fillStyle = steel ? "#666c76" : K.chestBand;
		a.fillRect(x + 2, y + 7, 11, 2);
		a.fillRect(x + 7, y + 3, 1, 10);
	}
	for (const i of W.inserters) {
		const x = i.c * T;
		const y = i.r * T;
		a.fillStyle = "#121315";
		a.fillRect(x + 5, y + 5, 7, 7);
		a.fillStyle = K.insBase;
		a.fillRect(x + 4, y + 4, 7, 7);
	}
	const poles = W.poles.map(([c, r]) => [c * T + 8, r * T + 4] as const);
	for (const [x, y] of poles) {
		a.fillStyle = K.poleD;
		a.fillRect(x - 3, y + 8, 7, 3);
		a.fillStyle = K.poleW;
		a.fillRect(x - 1, y - 2, 3, 12);
		a.fillRect(x - 4, y - 2, 9, 2);
	}
	for (let i = 0; i < poles.length; i++) {
		const [x0, y0] = poles[i]!;
		let best: readonly [number, number] | null = null;
		let d0 = 1e9;
		for (let j = 0; j < poles.length; j++) {
			const [x1, y1] = poles[j]!;
			if (j === i || x1 < x0 || (x1 === x0 && y1 <= y0)) continue;
			const d = Math.hypot(x1 - x0, y1 - y0);
			if (d < d0 && d < 12 * T) {
				d0 = d;
				best = poles[j]!;
			}
		}
		if (best === null) continue;
		const [x1, y1] = best;
		for (let s = 0; s <= 1; s += 1 / Math.max(8, d0)) {
			px(a, x0 + (x1 - x0) * s, y0 + (y1 - y0) * s + Math.sin(s * Math.PI) * 6 - 1, K.wire);
		}
	}
	// The chevrons never change (the sheet redrew them every step on top).
	a.fillStyle = K.chev;
	for (const b of W.belts) {
		for (const tl of b.tiles) {
			const x = tl.c * T;
			const y = tl.r * T;
			if (tl.dx) {
				const cx = x + 6 + (tl.dx > 0 ? 0 : 2);
				for (let k = 0; k < 3; k++) {
					a.fillRect(cx + tl.dx * k, y + 4 + k, 1, 1);
					a.fillRect(cx + tl.dx * k, y + 11 - k, 1, 1);
				}
			} else {
				const cy = y + 6 + (tl.dy > 0 ? 0 : 2);
				for (let k = 0; k < 3; k++) {
					a.fillRect(x + 4 + k, cy + tl.dy * k, 1, 1);
					a.fillRect(x + 11 - k, cy + tl.dy * k, 1, 1);
				}
			}
		}
	}
	return cv;
}

let WORLD: World | null = null;
const BAKES = new Map<string, OffscreenCanvas>();

function world(): World {
	if (WORLD === null) WORLD = build();
	return WORLD;
}

function worldBake(seed: string): OffscreenCanvas {
	let b = BAKES.get(seed);
	if (b === undefined) {
		b = bakeWorld(world(), seed);
		BAKES.set(seed, b);
	}
	return b;
}

const ITEM: Readonly<Record<ItemKind, string>> = {
	doc: K.doc,
	proto: K.proto,
	decision: K.decision,
	agent: K.agent,
};

/** The train: every four minutes, along the top a tile a second, twenty seconds at the dock, then away down the side. */
function trainHead(t: number, motion: boolean): number | null {
	const W = world();
	const railLen = W.rail.right + R;
	const stop = W.rail.right + 40;
	if (!motion) return stop;
	const ph = t % 240000;
	if (ph < stop * 1000) return Math.floor(ph / 1000);
	if (ph < stop * 1000 + 20000) return stop;
	if (ph < stop * 1000 + 20000 + (railLen - stop) * 1000)
		return stop + Math.floor((ph - stop * 1000 - 20000) / 1000);
	return null;
}

function create(scene: ArtScene): ThemeInstance {
	const ox = Math.round(scene.W / 2 - AW / 2);
	const oy = Math.round(scene.H / 2 - AH / 2);
	return {
		bake(g) {
			g.imageSmoothingEnabled = false;
			g.drawImage(worldBake(scene.seed), ox, oy);
		},
		// Belts, arms, gears and fire move every two seconds, smoke every
		// four; the train a tile a second while it runs.
		key: (t) => `${Math.floor(t / 2000)}|${Math.floor(t / 4000)}|${trainHead(t, scene.motion)}`,
		step(t0, a) {
			const Wd = world();
			const t = scene.motion ? t0 : 0;
			const step = Math.floor(t / 2000);
			const boxes: Box[] = [];
			const mark = (x: number, y: number, w: number, h: number) =>
				boxes.push({ x: ox + x, y: oy + y, w, h });
			a.save();
			a.translate(ox, oy);
			for (const b of Wd.belts) {
				b.tiles.forEach((tl, i) => {
					if ((((i - step) % 3) + 3) % 3 !== 0) return;
					const x = tl.c * T;
					const y = tl.r * T;
					a.fillStyle = K.itemEdge;
					a.fillRect(x + 4, y + 4, 8, 8);
					a.fillStyle = ITEM[b.kind];
					a.fillRect(x + 5, y + 5, 6, 6);
					if (b.kind === "doc") {
						a.fillStyle = K.docLine;
						a.fillRect(x + 6, y + 7, 4, 1);
						a.fillRect(x + 6, y + 9, 3, 1);
					}
					if (b.kind === "decision") {
						a.fillStyle = "#2f6f35";
						a.fillRect(x + 7, y + 7, 2, 2);
					}
					if (b.kind === "agent") {
						a.fillStyle = "#ffffff";
						a.fillRect(x + 7, y + 7, 2, 2);
					}
					mark(x + 4, y + 4, 8, 8);
				});
			}
			Wd.inserters.forEach((ins, k) => {
				const x = ins.c * T + 7;
				const y = ins.r * T + 7;
				const sw = (step + k) % 2 ? 1 : -1;
				const [ex, ey] =
					ins.dir === "v" ? [x + sw * 2, y + sw * 6] : [x + sw * 6, y + sw * 2];
				const col = ins.purple ? "#a66be0" : ins.fast ? K.insArmF : K.insArm;
				line(a, x, y, ex, ey, col);
				line(a, x + 1, y, ex + 1, ey, col);
				a.fillStyle = K.hand;
				a.fillRect(ex - 1, ey - 1, 3, 3);
				mark(x - 8, y - 8, 17, 17);
			});
			Wd.machines.forEach((m, k) => {
				const x = m.c * T + 24;
				const y = m.r * T + 20;
				const on = m.agent ? scene.active : true;
				const a0 = on ? ((step + k) % 4) * (Math.PI / 12) : 0;
				ring(a, x, y, 8, K.gearL);
				for (let s = 0; s < 6; s++) {
					const q = a0 + (s * Math.PI) / 3;
					line(
						a,
						x + Math.cos(q) * 3,
						y + Math.sin(q) * 3,
						x + Math.cos(q) * 9,
						y + Math.sin(q) * 9,
						K.gearL,
					);
				}
				a.fillStyle = K.gearD;
				a.fillRect(x - 2, y - 2, 5, 5);
				mark(x - 10, y - 10, 21, 21);
				if (m.agent && on) {
					a.fillStyle = K.padOn;
					a.fillRect(m.c * T + 6, m.r * T + 39, 36, 5);
					a.fillStyle = "#a6e89a";
					a.fillRect(m.c * T + 6 + ((step + k) % 9) * 4, m.r * T + 39, 4, 1);
					mark(m.c * T + 6, m.r * T + 39, 36, 5);
				}
			});
			if (scene.active) {
				Wd.domes.forEach((dm, k) => {
					if ((k + step) % 5 === 0) return;
					const x = dm.c * T + 24;
					const y = dm.r * T + 24;
					disc(a, x, y, 6, K.domeLit);
					disc(a, x, y, 2, "#ffffff");
					mark(x - 7, y - 7, 15, 15);
				});
			}
			const Rs = pixRng("plant6-smoke/" + scene.seed + "/" + Math.floor(t / 4000));
			Wd.furnaces.forEach(([c, r], k) => {
				const x = c * T;
				const y = r * T;
				if ((k + step) % 5 !== 0) {
					a.fillStyle = K.fire;
					a.fillRect(x + 11, y + 19, 10, 6);
					a.fillStyle = "#ffe08a";
					a.fillRect(x + 13, y + 21, 6, 3);
					mark(x + 11, y + 19, 10, 6);
				}
				if (Rs() < 0.35) {
					for (let s = 0; s < 4; s++)
						disc(a, x + 22 + s * 3 + Rs() * 2, y - 2 - s * 5, 1 + s, K.smoke);
					mark(x + 18, y - 24, 22, 26);
				}
			});
			const railLen = Wd.rail.right + R;
			const head = trainHead(t, scene.motion);
			if (head !== null) {
				for (let k = 0; k < 4; k++) {
					const p = head - k * 3;
					if (p < 0 || p > railLen) continue;
					const vertical = p > Wd.rail.right;
					const x = vertical ? Wd.rail.right * T + 1 : p * T - 16;
					const y = vertical
						? (Wd.rail.top + (p - Wd.rail.right)) * T - 16
						: Wd.rail.top * T + 1;
					const w = vertical ? 14 : 44;
					const h = vertical ? 44 : 14;
					a.fillStyle = "#0f1013";
					a.fillRect(x + 1, y + 1, w, h);
					a.fillStyle = k === 0 ? K.loco : K.wagon;
					a.fillRect(x, y, w, h);
					a.fillStyle = k === 0 ? K.locoRoof : "#9aa1ab";
					if (vertical) a.fillRect(x + 3, y + 4, w - 6, h - 8);
					else a.fillRect(x + 4, y + 3, w - 8, h - 6);
					if (k) {
						a.fillStyle = K.proto;
						for (const q of [8, 20, 32]) {
							if (vertical) a.fillRect(x + 5, y + q, 4, 4);
							else a.fillRect(x + q, y + 5, 4, 4);
						}
					}
					mark(x, y, w + 1, h + 1);
				}
			}
			a.restore();
			return boxes;
		},
	};
}

export const plant: ThemeDef = {
	id: "plant",
	maxAlpha: [0.185, 0.26],
	pad: 20,
	ramp: 80,
	shape: null,
	stepMs: 1000,
	scale: () => 1,
	pixelated: true,
	cpuBake: false,
	movers: "dyn",
	bakeReadsMask: false,
	create,
};
