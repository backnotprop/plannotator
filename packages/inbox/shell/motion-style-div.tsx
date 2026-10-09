// Copied from Workspaces apps/web/src/components/ui/motion-style-div.tsx
// (cd4a9bfd1) for the Inbox sidebar (the owner, 2026-10-09: the same component
// and motion). Port: imports from `motion/react` (the same framer-motion 12.43.0).

import * as React from "react";
import { cancelFrame, frame, type MotionValue } from "motion/react";

/**
 * The shell's MotionValue-to-style binder: a plain `div` whose `width`,
 * `left`, `opacity` and `x` follow MotionValues, written on the frame loop's
 * render step exactly as framer's DOM renderer writes them (px for lengths,
 * `translateX(Npx)` for x and `none` at 0, opacity as a bare number).
 *
 * Why not `m.div` under `LazyMotion features={domMin}`: that renderer is
 * framer's whole visual element (variants, animation state, projection
 * geometry, the SVG arm), about 20 KB gz on the boot path, to write four
 * numbers the shell's open/close spring and resize drag move. The shell
 * never animates through props, gestures or layout; the routes that do
 * (the document rail, the board) keep `motion.*`.
 */
export interface MotionStyleValues {
	width?: MotionValue<number>;
	left?: MotionValue<number>;
	opacity?: MotionValue<number>;
	x?: MotionValue<number>;
}

type MotionStyleKey = keyof MotionStyleValues;

const KEYS: readonly MotionStyleKey[] = ["width", "left", "opacity", "x"];

/** The CSS property and value framer's renderer writes for one key. */
function cssFor(
	key: MotionStyleKey,
	value: number,
): ["width" | "left" | "opacity" | "transform", string] {
	if (key === "x") return ["transform", value === 0 ? "none" : `translateX(${String(value)}px)`];
	if (key === "opacity") return ["opacity", String(value)];
	return [key, `${String(value)}px`];
}

function styleFor(values: MotionStyleValues): React.CSSProperties {
	const style: Record<string, string> = {};
	for (const key of KEYS) {
		const value = values[key];
		if (value === undefined) continue;
		const [property, css] = cssFor(key, value.get());
		style[property] = css;
	}
	return style as React.CSSProperties;
}

export function MotionStyleDiv({
	motionStyle,
	style,
	ref,
	...props
}: React.ComponentProps<"div"> & { motionStyle: MotionStyleValues }) {
	const element = React.useRef<HTMLDivElement | null>(null);
	const setRef = React.useCallback(
		(node: HTMLDivElement | null) => {
			element.current = node;
			if (typeof ref === "function") return ref(node);
			if (ref) ref.current = node;
			return undefined;
		},
		[ref],
	);

	const { width, left, opacity, x } = motionStyle;
	React.useLayoutEffect(() => {
		const values: MotionStyleValues = { width, left, opacity, x };
		// One write per frame, on the render step, whichever inputs moved.
		const render = () => {
			const node = element.current;
			if (node === null) return;
			for (const key of KEYS) {
				const value = values[key];
				if (value === undefined) continue;
				const [property, css] = cssFor(key, value.get());
				node.style[property] = css;
			}
		};
		const schedule = () => frame.render(render, false, true);
		const subscriptions = KEYS.flatMap((key) => {
			const value = values[key];
			return value === undefined ? [] : [value.on("change", schedule)];
		});
		return () => {
			for (const unsubscribe of subscriptions) unsubscribe();
			cancelFrame(render);
		};
	}, [width, left, opacity, x]);

	return <div ref={setRef} style={{ ...style, ...styleFor(motionStyle) }} {...props} />;
}
