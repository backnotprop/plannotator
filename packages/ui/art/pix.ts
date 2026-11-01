// The pixel kit for the worlds (design lane art/worlds/pix.js), on
// OffscreenCanvas so it runs in the worker. Sprites are made once at one art
// pixel per pixel and cached; lines and circles are plotted pixel by pixel.

export type Ctx = OffscreenCanvasRenderingContext2D;

export function canvas(w: number, h: number): OffscreenCanvas {
	return new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
}

export function ctx2d(c: OffscreenCanvas, cpu = false): Ctx {
	const g = c.getContext("2d", cpu ? { willReadFrequently: true } : undefined);
	if (g === null) throw new Error("2d context unavailable");
	return g;
}

const cache = new Map<string, OffscreenCanvas>();

/** A sprite built by a plotting function at one art pixel per pixel. */
export function made(
	key: string,
	w: number,
	h: number,
	plot: (g: Ctx, w: number, h: number) => void,
): OffscreenCanvas {
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const c = canvas(w, h);
	plot(ctx2d(c), w, h);
	cache.set(key, c);
	return c;
}

export function px(g: Ctx, x: number, y: number, col: string): void {
	g.fillStyle = col;
	g.fillRect(Math.round(x), Math.round(y), 1, 1);
}

export function line(g: Ctx, x0: number, y0: number, x1: number, y1: number, col: string): void {
	x0 = Math.round(x0);
	y0 = Math.round(y0);
	x1 = Math.round(x1);
	y1 = Math.round(y1);
	const dx = Math.abs(x1 - x0);
	const dy = -Math.abs(y1 - y0);
	const sx = x0 < x1 ? 1 : -1;
	const sy = y0 < y1 ? 1 : -1;
	let err = dx + dy;
	g.fillStyle = col;
	for (;;) {
		g.fillRect(x0, y0, 1, 1);
		if (x0 === x1 && y0 === y1) break;
		const e2 = 2 * err;
		if (e2 >= dy) {
			err += dy;
			x0 += sx;
		}
		if (e2 <= dx) {
			err += dx;
			y0 += sy;
		}
	}
}

export function disc(g: Ctx, cx: number, cy: number, r: number, col: string): void {
	g.fillStyle = col;
	for (let y = -r; y <= r; y++) {
		const w = Math.floor(Math.sqrt(r * r - y * y + r * 0.6));
		g.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1);
	}
}

export function ring(g: Ctx, cx: number, cy: number, r: number, col: string): void {
	for (let a = 0; a < 360; a += 2) {
		px(g, cx + Math.cos((a * Math.PI) / 180) * r, cy + Math.sin((a * Math.PI) / 180) * r, col);
	}
}

/** A 3 by 5 pixel font: one 15-character on/off string per glyph. */
export function word(
	g: Ctx,
	font: Readonly<Record<string, string>>,
	s: string,
	x: number,
	y: number,
	col: string,
): void {
	g.fillStyle = col;
	for (let i = 0; i < s.length; i++) {
		const f = font[s[i] ?? " "];
		if (f === undefined) continue;
		for (let k = 0; k < 15; k++) {
			if (f[k] === "1") g.fillRect(x + i * 4 + (k % 3), y + Math.floor(k / 3), 1, 1);
		}
	}
}
