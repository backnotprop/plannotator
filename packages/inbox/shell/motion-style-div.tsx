import * as React from "react";
import { cancelFrame, frame, type MotionValue } from "motion/react";

/** A plain `div` whose `width`, `left`, `opacity` and `x` follow MotionValues. Not `m.div`: that renderer is about 20 KB gz on the boot path to write four numbers. */
export interface MotionStyleValues {
	width?: MotionValue<number>;
	left?: MotionValue<number>;
	opacity?: MotionValue<number>;
	x?: MotionValue<number>;
}

type MotionStyleKey = keyof MotionStyleValues;

const KEYS: readonly MotionStyleKey[] = ["width", "left", "opacity", "x"];

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
