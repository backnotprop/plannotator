import type { Box } from "./themes/types";

/** Dirty boxes are snapped to tiles this size (layer px) and merged. */
const TILE = 32;

/** Snap boxes to TILE tiles inside the layer and merge them into rectangles. */
export function mergeBoxes(boxes: readonly Box[], LW: number, LH: number): Box[] {
	const tw = Math.ceil(LW / TILE);
	const th = Math.ceil(LH / TILE);
	const hit = new Uint8Array(tw * th);
	let any = false;
	for (const b of boxes) {
		const x0 = Math.max(0, Math.floor(b.x / TILE));
		const y0 = Math.max(0, Math.floor(b.y / TILE));
		const x1 = Math.min(tw - 1, Math.floor((b.x + b.w) / TILE));
		const y1 = Math.min(th - 1, Math.floor((b.y + b.h) / TILE));
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				hit[y * tw + x] = 1;
				any = true;
			}
		}
	}
	if (!any) return [];
	// runs per row, then stack identical runs on consecutive rows
	const open = new Map<string, { x: number; y: number; w: number; h: number }>();
	const out: Box[] = [];
	for (let y = 0; y < th; y++) {
		const seen = new Set<string>();
		for (let x = 0; x < tw; ) {
			if (!hit[y * tw + x]) {
				x++;
				continue;
			}
			let e = x;
			while (e < tw && hit[y * tw + e]) e++;
			const key = x + ":" + e;
			const run = open.get(key);
			if (run !== undefined && run.y + run.h === y) run.h++;
			else {
				if (run !== undefined) out.push(run);
				open.set(key, { x, y, w: e - x, h: 1 });
			}
			seen.add(key);
			x = e;
		}
		for (const [key, run] of open) {
			if (!seen.has(key)) {
				out.push(run);
				open.delete(key);
			}
		}
	}
	for (const run of open.values()) out.push(run);
	return out.map((r) => {
		const x = r.x * TILE;
		const y = r.y * TILE;
		return { x, y, w: Math.min(LW, x + r.w * TILE) - x, h: Math.min(LH, y + r.h * TILE) - y };
	});
}
