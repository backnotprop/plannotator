// The quiet mask (design lane art/art.js `buildMask`): a grid at MASK_CELL
// CSS px that is 0 inside every keep rectangle and within the theme's pad,
// rises to 1 over its ramp, times the theme's own shape. Three box-blur
// passes turn rectangular clearings into organic ones, and the hard rule
// survives the blur: the value never rises above its raw value near a keep.
//
// Built only when the layout changes (never per step). The distance is
// computed exactly, like the sheet's, but only inside each rectangle's reach
// (pad plus ramp), so the cost follows the rectangles, not grid times rects.

import { clamp, smooth } from "./noise";

export const MASK_CELL = 4;
const BLUR = 9;

export interface ArtRect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

export interface Mask {
	readonly grid: Float32Array;
	readonly gw: number;
	readonly gh: number;
	at(x: number, y: number): number;
}

export type MaskShape = (u: number, v: number) => number;

export function buildMask(
	W: number,
	H: number,
	rects: readonly ArtRect[],
	pad: number,
	ramp: number,
	shape: MaskShape | null,
): Mask {
	const gw = Math.ceil(W / MASK_CELL) + 1;
	const gh = Math.ceil(H / MASK_CELL) + 1;
	const reach = pad + ramp;
	const dist = new Float32Array(gw * gh).fill(reach);
	for (const r of rects) {
		const gx0 = Math.max(0, Math.floor((r.x - reach) / MASK_CELL));
		const gx1 = Math.min(gw - 1, Math.ceil((r.x + r.w + reach) / MASK_CELL));
		const gy0 = Math.max(0, Math.floor((r.y - reach) / MASK_CELL));
		const gy1 = Math.min(gh - 1, Math.ceil((r.y + r.h + reach) / MASK_CELL));
		for (let gy = gy0; gy <= gy1; gy++) {
			const y = gy * MASK_CELL;
			const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
			for (let gx = gx0; gx <= gx1; gx++) {
				const x = gx * MASK_CELL;
				const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
				const d = Math.hypot(dx, dy);
				const i = gy * gw + gx;
				if (d < (dist[i] ?? reach)) dist[i] = d;
			}
		}
	}
	const m = new Float32Array(gw * gh);
	for (let gy = 0; gy < gh; gy++) {
		for (let gx = 0; gx < gw; gx++) {
			const i = gy * gw + gx;
			const s = shape === null ? 1 : shape((gx * MASK_CELL) / W, (gy * MASK_CELL) / H);
			m[i] = smooth(pad, reach, dist[i] ?? reach) * s;
		}
	}
	const raw = Float32Array.from(m);
	const tmp = new Float32Array(m.length);
	for (let pass = 0; pass < 3; pass++) {
		for (let y = 0; y < gh; y++) {
			let acc = 0;
			let n = 0;
			for (let x = -BLUR; x < gw; x++) {
				if (x + BLUR < gw) {
					acc += m[y * gw + x + BLUR] ?? 0;
					n++;
				}
				if (x - BLUR - 1 >= 0) {
					acc -= m[y * gw + x - BLUR - 1] ?? 0;
					n--;
				}
				if (x >= 0) tmp[y * gw + x] = acc / n;
			}
		}
		for (let x = 0; x < gw; x++) {
			let acc = 0;
			let n = 0;
			for (let y = -BLUR; y < gh; y++) {
				if (y + BLUR < gh) {
					acc += tmp[(y + BLUR) * gw + x] ?? 0;
					n++;
				}
				if (y - BLUR - 1 >= 0) {
					acc -= tmp[(y - BLUR - 1) * gw + x] ?? 0;
					n--;
				}
				if (y >= 0) m[y * gw + x] = acc / n;
			}
		}
	}
	for (let i = 0; i < m.length; i++) {
		const r0 = raw[i] ?? 0;
		const v = m[i] ?? 0;
		if (r0 < v) m[i] = r0 + (v - r0) * smooth(0, 0.5, r0);
	}
	const at = (x: number, y: number): number => {
		const fx = clamp(x / MASK_CELL, 0, gw - 1.001);
		const fy = clamp(y / MASK_CELL, 0, gh - 1.001);
		const ix = fx | 0;
		const iy = fy | 0;
		const tx = fx - ix;
		const ty = fy - iy;
		const a = m[iy * gw + ix] ?? 0;
		const b = m[iy * gw + ix + 1] ?? 0;
		const c = m[(iy + 1) * gw + ix] ?? 0;
		const d = m[(iy + 1) * gw + ix + 1] ?? 0;
		return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
	};
	return { grid: m, gw, gh, at };
}
