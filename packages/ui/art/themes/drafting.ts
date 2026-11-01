// Drafting (design lane art/art.js): the printed engineering sheet (grid,
// stations, compass circles, rulers, a dimension, the title block) with the
// drafter's pen work drawn on it by hand. The sheet is printed and still; the
// pen draws one stroke a second, a new drawing every ten minutes, then holds.
// Each stroke is the same stroke at every step: a stroke not yet due still
// consumes its randomness.
//
// The one device-scale theme (hairlines need it). The bake is CPU-backed:
// strokes overlap, so the ceiling is clamped per pixel there, once for the
// sheet and then only inside each new stroke's box. Nothing is read back from
// the GPU.

import { TAU, clamp, fbm, lerp, rgba, rng, smooth, vn, type Rgb } from "../noise";
import { mergeBoxes } from "../boxes";
import type { Ctx } from "../pix";
import type { ArtScene, Box, ThemeDef, ThemeInstance } from "./types";

const PERIOD = 600000;
const MAX_ALPHA: readonly [number, number] = [0.22, 0.34];

/**
 * The pen's strokes for one sheet, recorded once in drawing order (the same
 * order and randomness as the sheet's pen, all strokes inked) and replayed
 * one per step. A stroke is its ink, its dashes or segments, and its box.
 */
interface Stroke {
	readonly style: string;
	/** The ground the stroke covers, piece by piece (CSS px: x0, y0, x1, y1). */
	readonly cover: number[];
	/** x0, y0, x1, y1, width per segment (hand strokes). */
	readonly segs: number[];
	/** One path per line weight (scumble layers). */
	readonly paths: Map<number, Path2D>;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

function newStroke(style: string): Stroke {
	return { style, cover: [], segs: [], paths: new Map(), x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
}

/** Grow the stroke's current piece; a long stroke is covered by many small pieces. */
function grow(s: Stroke, x: number, y: number, r: number): void {
	if (x - r < s.x0) s.x0 = x - r;
	if (y - r < s.y0) s.y0 = y - r;
	if (x + r > s.x1) s.x1 = x + r;
	if (y + r > s.y1) s.y1 = y + r;
}

function closePiece(s: Stroke): void {
	if (s.x1 < s.x0) return;
	s.cover.push(s.x0, s.y0, s.x1, s.y1);
	s.x0 = 1e9;
	s.y0 = 1e9;
	s.x1 = -1e9;
	s.y1 = -1e9;
}

function drawStroke(g: Ctx, s: Stroke): void {
	g.strokeStyle = s.style;
	g.lineCap = "round";
	const q = s.segs;
	for (let i = 0; i < q.length; i += 5) {
		g.lineWidth = q[i + 4]!;
		g.beginPath();
		g.moveTo(q[i]!, q[i + 1]!);
		g.lineTo(q[i + 2]!, q[i + 3]!);
		g.stroke();
	}
	for (const [weight, path] of s.paths) {
		g.lineWidth = weight / 10;
		g.stroke(path);
	}
}

interface StrokeStyle {
	readonly w: number;
	readonly wander?: number;
	readonly tremor?: number;
	readonly lift?: number;
}

function handStroke(
	out: Stroke[],
	style: string,
	pts: readonly (readonly [number, number])[],
	o: StrokeStyle,
	R: () => number,
): void {
	const stroke = newStroke(style);
	out.push(stroke);
	const rs: [number, number][] = [];
	for (let i = 0; i < pts.length - 1; i++) {
		const [x0, y0] = pts[i]!;
		const [x1, y1] = pts[i + 1]!;
		const L = Math.hypot(x1 - x0, y1 - y0);
		const n = Math.max(1, Math.ceil(L / 3));
		for (let k = 0; k < n; k++) rs.push([lerp(x0, x1, k / n), lerp(y0, y1, k / n)]);
	}
	const last = pts[pts.length - 1]!;
	rs.push([last[0], last[1]]);
	let total = 0;
	const acc = [0];
	for (let i = 1; i < rs.length; i++) {
		total += Math.hypot(rs[i]![0] - rs[i - 1]![0], rs[i]![1] - rs[i - 1]![1]);
		acc.push(total);
	}
	const f1 = lerp(0.8, 2.4, R());
	const f2 = lerp(4, 9, R());
	const p1 = R() * TAU;
	const p2 = R() * TAU;
	const amp = (o.wander ?? 0.6) * clamp(0.5 + total / 400, 0.5, 2.2);
	const nz = R() * 100;
	const P = rs.map(([x, y], i): [number, number, number] => {
		const a = rs[Math.min(i + 1, rs.length - 1)]!;
		const b = rs[Math.max(i - 1, 0)]!;
		let nx = -(a[1] - b[1]);
		let ny = a[0] - b[0];
		const nl = Math.hypot(nx, ny) || 1;
		nx /= nl;
		ny /= nl;
		const u = acc[i]! / (total || 1);
		const off =
			amp * (0.7 * Math.sin(TAU * f1 * u + p1) + 0.25 * Math.sin(TAU * f2 * u + p2)) +
			(R() - 0.5) * (o.tremor ?? 0.2);
		return [x + nx * off, y + ny * off, u];
	});
	for (let i = 1; i < P.length; i++) {
		if (o.lift && R() < o.lift) continue;
		const u = P[i]![2];
		const taper = Math.min(1, (u * total) / 10, ((1 - u) * total) / 14 + 0.25);
		const press = 0.75 + 0.5 * vn(acc[i]! / 40, 0, nz);
		const w = Math.max(0.35, o.w * press * taper);
		stroke.segs.push(P[i - 1]![0], P[i - 1]![1], P[i]![0], P[i]![1], w);
		grow(stroke, P[i]![0], P[i]![1], w + 1);
		grow(stroke, P[i - 1]![0], P[i - 1]![1], w + 1);
		if (i % 12 === 0) closePiece(stroke);
	}
	closePiece(stroke);
}

function overshoot(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	k: number,
): [[number, number], [number, number]] {
	const L = Math.hypot(x1 - x0, y1 - y0) || 1;
	const ux = (x1 - x0) / L;
	const uy = (y1 - y0) / L;
	return [
		[x0 - ux * k, y0 - uy * k],
		[x1 + ux * k, y1 + uy * k],
	];
}

function drawSheet(g: Ctx, W: number, H: number, dark: boolean, seed: string, date: string): void {
	const ink: Rgb = dark ? [30, 182, 255] : [0, 111, 230];
	const A = dark ? 0.13 : 0.11;
	const R = rng("sheet/" + seed);
	g.lineWidth = 0.5;
	for (let x = 0.25; x < W; x += 10) {
		g.strokeStyle = rgba(ink, Math.round(x / 10) % 5 === 0 ? A * 0.9 : A * 0.38);
		g.beginPath();
		g.moveTo(x, 0);
		g.lineTo(x, H);
		g.stroke();
	}
	for (let y = 0.25; y < H; y += 10) {
		g.strokeStyle = rgba(ink, Math.round(y / 10) % 5 === 0 ? A * 0.9 : A * 0.38);
		g.beginPath();
		g.moveTo(0, y);
		g.lineTo(W, y);
		g.stroke();
	}
	g.lineWidth = 0.9;
	g.strokeStyle = rgba(ink, A * 1.7);
	const sx = Math.round((W * 0.84) / 10) * 10;
	const sy = Math.round((H * 0.16) / 10) * 10;
	g.beginPath();
	g.moveTo(sx, -4);
	g.lineTo(sx, H + 4);
	g.moveTo(-4, sy);
	g.lineTo(W + 4, sy);
	g.stroke();
	g.setLineDash([26, 4, 5, 4]);
	g.beginPath();
	g.moveTo(-4, Math.round((H * 0.74) / 10) * 10);
	g.lineTo(W + 4, Math.round((H * 0.74) / 10) * 10);
	g.stroke();
	g.setLineDash([]);
	const cx = sx;
	const cy = Math.round((H * 0.74) / 10) * 10;
	const r = Math.min(W, H) * 0.3;
	for (let p = 0; p < 2; p++) {
		g.beginPath();
		const a0 = R() * TAU;
		const turn = lerp(0.96, 1.04, R());
		for (let k = 0; k <= 240; k++) {
			const a = a0 + (k / 240) * turn * TAU;
			const rr = r * (1 + 0.006 * Math.sin(a * 3 + p));
			if (k) g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
			else g.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
		}
		g.stroke();
	}
	g.beginPath();
	g.arc(cx, cy, r * 0.42, 0, TAU);
	g.stroke();
	g.lineWidth = 0.6;
	for (let x = 0; x < W; x += 10) {
		const L = x % 100 === 0 ? 11 : x % 50 === 0 ? 7 : 4;
		g.beginPath();
		g.moveTo(x + 0.25, H);
		g.lineTo(x + 0.25, H - L);
		g.stroke();
	}
	for (let y = 0; y < H; y += 10) {
		const L = y % 100 === 0 ? 11 : y % 50 === 0 ? 7 : 4;
		g.beginPath();
		g.moveTo(W, y + 0.25);
		g.lineTo(W - L, y + 0.25);
		g.stroke();
	}
	const dy = sy - 30;
	const x0 = 40;
	const x1 = sx;
	g.lineWidth = 0.8;
	g.beginPath();
	g.moveTo(x0, dy);
	g.lineTo(x1, dy);
	g.moveTo(x0, dy - 6);
	g.lineTo(x0, dy + 6);
	g.moveTo(x1, dy - 6);
	g.lineTo(x1, dy + 6);
	g.stroke();
	for (const [ax, dir] of [
		[x0, 1],
		[x1, -1],
	] as const) {
		g.beginPath();
		g.moveTo(ax, dy);
		g.lineTo(ax + 8 * dir, dy - 2.5);
		g.lineTo(ax + 8 * dir, dy + 2.5);
		g.closePath();
		g.fillStyle = rgba(ink, A * 1.7);
		g.fill();
	}
	g.font = '11px "Ioskeley Mono", ui-monospace, monospace';
	g.fillStyle = rgba(ink, A * 2);
	const label = String(Math.round(x1 - x0));
	const tw = g.measureText(label).width;
	g.clearRect((x0 + x1) / 2 - tw / 2 - 6, dy - 8, tw + 12, 16);
	g.fillText(label, (x0 + x1) / 2 - tw / 2, dy + 4);
	const bw = 236;
	const bh = 58;
	const bx = W - bw - 22;
	const by = H - bh - 22;
	g.lineWidth = 0.9;
	g.strokeStyle = rgba(ink, A * 2);
	g.strokeRect(bx + 0.5, by + 0.5, bw, bh);
	g.beginPath();
	g.moveTo(bx, by + 20.5);
	g.lineTo(bx + bw, by + 20.5);
	g.moveTo(bx, by + 39.5);
	g.lineTo(bx + bw, by + 39.5);
	g.moveTo(bx + 150.5, by + 20);
	g.lineTo(bx + 150.5, by + bh);
	g.stroke();
	g.fillText("PLANNOTATOR WORKSPACES", bx + 8, by + 14);
	g.fillText("SHEET 01", bx + 8, by + 34);
	g.fillText("1:1", bx + 158, by + 34);
	g.fillText(date, bx + 8, by + 53);
	g.fillText("REV A", bx + 158, by + 53);
}

function recordPen(W: number, H: number, dark: boolean, seed: string, sheetNo: number): Stroke[] {
	const out: Stroke[] = [];
	let style = "";
	const R = rng("pen/" + seed + "/" + sheetNo);
	const blue: Rgb = dark ? [140, 170, 235] : [96, 124, 200];
	const lead: Rgb = dark ? [226, 230, 238] : [58, 58, 62];
	const A = dark ? 0.16 : 0.17;
	style = rgba(blue, A * 1.1);
	const st: readonly (readonly [number, number, number, number])[] = [
		[-10, H * 0.22, W + 10, H * 0.205],
		[-10, H * 0.81, W + 10, H * 0.83],
		[W * 0.12, -10, W * 0.115, H + 10],
		[W * 0.88, -10, W * 0.885, H + 10],
		[W * 0.55, H + 10, W + 10, H * 0.38],
	];
	for (const [x0, y0, x1, y1] of st) {
		handStroke(
			out,
			style,
			overshoot(x0, y0, x1, y1, 14),
			{ w: 0.9, wander: 0.6, tremor: 0.35, lift: 0.035 },
			R,
		);
	}
	const gx = W * 0.88;
	const gy = H * 0.83;
	const gr = Math.min(W, H) * 0.24;
	for (let p = 0; p < 2; p++) {
		const a0 = R() * TAU;
		const turn = lerp(0.96, 1.06, R());
		const pts: [number, number][] = [];
		for (let k = 0; k <= 120; k++) {
			const a = a0 + (k / 120) * turn * TAU;
			pts.push([
				gx + Math.cos(a) * gr * (1 + p * 0.012),
				gy + Math.sin(a) * gr * (1 + p * 0.012),
			]);
		}
		handStroke(out, style, pts, { w: 0.8, wander: 0.5, tremor: 0.3, lift: 0.03 }, R);
	}
	const s = Math.min(W, H) * 0.075;
	const ox = gx - s * 0.2;
	const oy = gy + s * 0.2;
	const c30 = Math.cos(Math.PI / 6);
	const s30 = 0.5;
	const Pt = (x: number, y: number, z: number): [number, number] => [
		ox + (x - y) * c30 * s,
		oy + (x + y) * s30 * s - z * s,
	];
	type V3 = readonly [number, number, number];
	const edges: readonly (readonly [V3, V3])[] = [
		[
			[0, 0, 1],
			[1, 0, 1],
		],
		[
			[1, 0, 1],
			[1, 1, 1],
		],
		[
			[1, 1, 1],
			[0, 1, 1],
		],
		[
			[0, 1, 1],
			[0, 0, 1],
		],
		[
			[1, 0, 1],
			[1, 0, 0],
		],
		[
			[1, 1, 1],
			[1, 1, 0],
		],
		[
			[0, 1, 1],
			[0, 1, 0],
		],
		[
			[1, 0, 0],
			[1, 1, 0],
		],
		[
			[1, 1, 0],
			[0, 1, 0],
		],
	];
	for (const [a, b] of edges) {
		const pa = Pt(a[0], a[1], a[2]);
		const pb = Pt(b[0], b[1], b[2]);
		const [p0, p1] = overshoot(pa[0], pa[1], pb[0], pb[1], 3);
		handStroke(out, rgba(lead, A * 1.6), [p0, p1], { w: 1.3, wander: 0.5, tremor: 0.25 }, R);
		handStroke(out, rgba(lead, A * 0.7), [p0, p1], { w: 0.8, wander: 0.9, tremor: 0.3 }, R);
	}
	style = rgba(lead, A * 0.9);
	for (let t = 0.08; t < 1; t += 0.085) {
		const a = Pt(1, t, 1);
		const b = Pt(1, t, 0);
		handStroke(
			out,
			style,
			[
				[a[0], a[1] + 1],
				[b[0], b[1] - 1],
			],
			{ w: 0.6, wander: 0.2, tremor: 0.15 },
			R,
		);
	}
	const pools = [
		{ x: W * 0.02, y: H * 0.98, r: Math.min(W, H) * 0.5 },
		{ x: W * 0.98, y: H * 0.02, r: Math.min(W, H) * 0.38 },
	];
	const ang = -1.05;
	style = rgba(lead, A * 0.85);
	for (const pool of pools) {
		for (let layer = 0; layer < 2; layer++) {
			const stroke = newStroke(style);
			out.push(stroke);
			const a2 = ang + layer * 0.5;
			const c2 = Math.cos(a2);
			const s2 = Math.sin(a2);
			const pitch = 4.2 + layer * 1.5;
			// One path per line weight (tenths of a pixel) instead of one per
			// dash: thousands of dashes, five stroke calls.
			const paths = stroke.paths;
			for (let d = -pool.r; d < pool.r; d += pitch * lerp(0.82, 1.18, R())) {
				for (let t = -pool.r; t < pool.r; ) {
					const len = lerp(10, 34, R());
					const gap = lerp(2, 14, R());
					const x0 = pool.x + c2 * t - s2 * d;
					const y0 = pool.y + s2 * t + c2 * d;
					const x1 = x0 + c2 * len;
					const y1 = y0 + s2 * len;
					const tone =
						1 -
						Math.hypot(x0 - pool.x, y0 - pool.y) / pool.r -
						fbm(x0 / 90, y0 / 90, 3) * 0.55 -
						layer * 0.2;
					if (tone > 0.05) {
						const weight = Math.round((0.6 + 0.4 * R()) * 10);
						let path = paths.get(weight);
						if (path === undefined) {
							path = new Path2D();
							paths.set(weight, path);
						}
						path.moveTo(x0, y0);
						path.lineTo(x1, y1);
						grow(stroke, x0, y0, 2);
						grow(stroke, x1, y1, 2);
						closePiece(stroke);
					}
					t += len + gap;
				}
			}
		}
	}
	return out;
}

/** Clamp every pixel's alpha inside `box` (layer px) on the CPU-backed bake. */
function clampAlpha(g: Ctx, box: Box, cap: number): void {
	const x = Math.max(0, Math.floor(box.x));
	const y = Math.max(0, Math.floor(box.y));
	const w = Math.min(g.canvas.width, Math.ceil(box.x + box.w)) - x;
	const h = Math.min(g.canvas.height, Math.ceil(box.y + box.h)) - y;
	if (w <= 0 || h <= 0) return;
	const img = g.getImageData(x, y, w, h);
	const d = img.data;
	const c = Math.round(255 * cap);
	let hit = false;
	for (let i = 3; i < d.length; i += 4) {
		if (d[i]! > c) {
			d[i] = c;
			hit = true;
		}
	}
	if (hit) g.putImageData(img, x, y);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

function localDate(t: number): string {
	const d = new Date(t);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function create(scene: ArtScene): ThemeInstance {
	const { W, H, dpr, dark, seed } = scene;
	const cap = MAX_ALPHA[dark ? 0 : 1];
	let sheetNo: number | null = null;
	let strokes: Stroke[] = [];
	let drawn = 0;
	const coverOf = (s: Stroke): Box[] => {
		const out: Box[] = [];
		const c = s.cover;
		for (let i = 0; i < c.length; i += 4) {
			out.push({
				x: Math.floor(c[i]! * dpr),
				y: Math.floor(c[i + 1]! * dpr),
				w: Math.ceil((c[i + 2]! - c[i]!) * dpr) + 2,
				h: Math.ceil((c[i + 3]! - c[i + 1]!) * dpr) + 2,
			});
		}
		return mergeBoxes(out, scene.LW, scene.LH);
	};
	return {
		bake() {
			sheetNo = null;
		},
		step(t, _dyn, g) {
			// The cycle is offset so a still frame (Reduce motion) shows a
			// finished drawing and a new drawing starts ten seconds in.
			const ph = scene.motion ? (t + PERIOD - 10000) % PERIOD : PERIOD - 1;
			const no = scene.motion ? Math.floor((t + PERIOD - 10000) / PERIOD) : 0;
			const due = scene.motion ? Math.floor(ph / 1000) : Number.POSITIVE_INFINITY;
			if (no !== sheetNo) {
				// A new sheet: print it, put down the strokes already due, and
				// clamp the whole plate once.
				strokes = recordPen(W, H, dark, seed, no);
				sheetNo = no;
				drawn = Math.min(due, strokes.length);
				g.save();
				g.setTransform(dpr, 0, 0, dpr, 0, 0);
				g.clearRect(0, 0, W, H);
				drawSheet(g, W, H, dark, seed, localDate(t || Date.now()));
				for (let i = 0; i < drawn; i++) drawStroke(g, strokes[i]!);
				g.restore();
				clampAlpha(g, { x: 0, y: 0, w: scene.LW, h: scene.LH }, cap);
				return "all";
			}
			const to = Math.min(due, strokes.length);
			if (to <= drawn) return [];
			const boxes: Box[] = [];
			for (let i = drawn; i < to; i++) {
				const s = strokes[i]!;
				g.save();
				g.setTransform(dpr, 0, 0, dpr, 0, 0);
				drawStroke(g, s);
				g.restore();
				for (const box of coverOf(s)) {
					clampAlpha(g, box, cap);
					boxes.push(box);
				}
			}
			drawn = to;
			return boxes;
		},
	};
}

export const drafting: ThemeDef = {
	id: "drafting",
	maxAlpha: MAX_ALPHA,
	pad: 22,
	ramp: 100,
	shape: (u, v) =>
		0.55 +
		0.45 *
			Math.max(
				smooth(0.35, 1, Math.abs(u - 0.5) * 2),
				smooth(0.4, 1, Math.abs(v - 0.45) * 2),
			),
	stepMs: 1000,
	scale: (dpr) => dpr,
	pixelated: false,
	cpuBake: true,
	movers: "plate",
	bakeReadsMask: false,
	create,
};
