// Seeded randomness and value noise, ported unchanged from the design lane's
// art/art.js and art/worlds/pix.js (research/design/desktop-art-themes-2026-10-01):
// the same seed, size and theme draw the same pixels as the sheet.

export const TAU = Math.PI * 2;

export function xmur3(str: string): number {
	let h = 1779033703 ^ str.length;
	for (let i = 0; i < str.length; i++) {
		h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	h = Math.imul(h ^ (h >>> 16), 2246822507);
	h = Math.imul(h ^ (h >>> 13), 3266489909);
	return (h ^= h >>> 16) >>> 0;
}

/** art.js's generator: the seed is hashed by xmur3 first. */
export function rng(seed: string): () => number {
	let a = xmur3(seed);
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** pix.js's generator (the three worlds and Lofi): a shorter seed hash. */
export function pixRng(seed: string): () => number {
	let h = 1779033703 ^ seed.length;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	let a = h >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const clamp = (v: number, a = 0, b = 1): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export function smooth(e0: number, e1: number, x: number): number {
	const t = clamp((x - e0) / (e1 - e0));
	return t * t * (3 - 2 * t);
}

function h2(x: number, y: number, s: number): number {
	const n = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
	return n - Math.floor(n);
}

export function vn(x: number, y: number, s: number): number {
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	const xf = x - xi;
	const yf = y - yi;
	const u = xf * xf * (3 - 2 * xf);
	const v = yf * yf * (3 - 2 * yf);
	return (
		h2(xi, yi, s) * (1 - u) * (1 - v) +
		h2(xi + 1, yi, s) * u * (1 - v) +
		h2(xi, yi + 1, s) * (1 - u) * v +
		h2(xi + 1, yi + 1, s) * u * v
	);
}

export function fbm(x: number, y: number, s: number, o = 4): number {
	let a = 0.5;
	let f = 1;
	let t = 0;
	let n = 0;
	for (let i = 0; i < o; i++) {
		t += vn(x * f, y * f, s + i * 17) * a;
		n += a;
		a *= 0.5;
		f *= 2.03;
	}
	return t / n;
}

/** The 4 by 4 ordered dither the Dither language already uses. */
export const BAYER: readonly (readonly number[])[] = [
	[0, 8, 2, 10],
	[12, 4, 14, 6],
	[3, 11, 1, 9],
	[15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

export type Rgb = readonly [number, number, number];
export const rgba = (c: Rgb, a: number): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

/** Lofi's integer hash. */
export function hash2(a: number, b: number): number {
	let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
