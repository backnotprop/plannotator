// The quiet mask's input, collected on the main thread when the layout
// changes (never per step): every element a person reads or presses that is
// visible over the ground, plus every visible run of text not inside one, so
// the art cannot sit behind a word nobody remembered to tag. The walk skips
// subtrees outside the ground's visible box and runs in idle chunks, so it
// never makes a long task.

import type { ArtRect } from "./mask";

/** A whole element is one keep: its subtree is not walked further. */
export const ART_KEEP_SELECTOR = [
	"[data-art-keep]",
	"article",
	"button",
	"a",
	"input",
	"textarea",
	"select",
	"label",
	"li",
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"img",
	"svg",
	"table",
	"pre",
	"[role=button]",
	"[role=link]",
	"[role=radio]",
	"[role=radiogroup]",
	"[role=checkbox]",
	"[role=switch]",
	"[role=tab]",
	"[role=menuitem]",
	"[role=row]",
	"[role=listitem]",
	"[data-tile]",
].join(",");

/** Floating surfaces that cover the ground from outside it (the agent panel). */
const FLOATING_KEEP_SELECTOR = "[data-assistant-window]";

interface IdleDeadlineLike {
	timeRemaining(): number;
}

function idle(fn: (deadline: IdleDeadlineLike) => void): () => void {
	if (typeof window.requestIdleCallback === "function") {
		const id = window.requestIdleCallback(fn, { timeout: 500 });
		return () => window.cancelIdleCallback(id);
	}
	const id = window.setTimeout(() => {
		const end = performance.now() + 8;
		fn({ timeRemaining: () => Math.max(0, end - performance.now()) });
	}, 0);
	return () => window.clearTimeout(id);
}

function overlaps(r: DOMRect, box: DOMRect): boolean {
	return (
		r.width >= 1 &&
		r.height >= 1 &&
		r.right > box.left &&
		r.left < box.right &&
		r.bottom > box.top &&
		r.top < box.bottom
	);
}

export interface CollectedLayout {
	readonly rects: ArtRect[];
	readonly active: boolean;
}

/**
 * Collect the keep rectangles over `ground`'s visible box, relative to it.
 * `skip` is the art layer itself. Returns a cancel function; `done` runs once.
 */
export function collectRects(
	ground: HTMLElement,
	skip: Element,
	done: (layout: CollectedLayout) => void,
): () => void {
	const doc = ground.ownerDocument;
	const box = ground.getBoundingClientRect();
	const rects: ArtRect[] = [];
	const push = (r: DOMRect) => {
		rects.push({ x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height });
	};
	const walker = doc.createTreeWalker(ground, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			if (node.nodeType === Node.TEXT_NODE) {
				return node.nodeValue !== null && node.nodeValue.trim() !== ""
					? NodeFilter.FILTER_ACCEPT
					: NodeFilter.FILTER_REJECT;
			}
			const el = node as Element;
			if (el === skip || el.getAttribute("aria-hidden") === "true")
				return NodeFilter.FILTER_REJECT;
			const r = el.getBoundingClientRect();
			// A subtree that does not reach the visible box is skipped whole.
			// (Positioned descendants that escape their parent are rare on the
			// grounds; the text runs inside the box are still found.)
			if (!overlaps(r, box) && getComputedStyle(el).overflow !== "visible")
				return NodeFilter.FILTER_REJECT;
			if (el.matches(ART_KEEP_SELECTOR)) {
				if (overlaps(r, box)) push(r);
				return NodeFilter.FILTER_REJECT;
			}
			return NodeFilter.FILTER_SKIP;
		},
	});
	const range = doc.createRange();
	let cancelIdle: (() => void) | null = null;
	let cancelled = false;
	const finish = () => {
		const floating = doc.querySelectorAll(FLOATING_KEEP_SELECTOR);
		for (const el of floating) {
			const r = el.getBoundingClientRect();
			if (overlaps(r, box)) push(r);
		}
		done({ rects, active: floating.length > 0 });
	};
	const work = (deadline: IdleDeadlineLike) => {
		cancelIdle = null;
		if (cancelled) return;
		let n = 0;
		for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
			if (node.nodeType === Node.TEXT_NODE) {
				range.selectNodeContents(node);
				for (const r of range.getClientRects()) if (overlaps(r, box)) push(r);
			}
			if (++n % 32 === 0 && deadline.timeRemaining() < 1) {
				cancelIdle = idle(work);
				return;
			}
		}
		finish();
	};
	cancelIdle = idle(work);
	return () => {
		cancelled = true;
		cancelIdle?.();
	};
}
