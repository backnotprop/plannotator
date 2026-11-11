/** Framer's animator is not needed to paint the shell (every surface mounts settled), so it loads in its own chunk. Importing the two pieces instead of `animate` leaves out the sequence and element-subject arms, keeping the chunk small. */
import {
	GroupAnimationWithThen,
	animateSingleValue,
	type MotionValue,
	type ValueAnimationTransition,
} from "motion/react";

export function animate(
	value: MotionValue<number>,
	target: number,
	options: ValueAnimationTransition<number>,
): GroupAnimationWithThen {
	const { onComplete, ...rest } = options;
	const animation = new GroupAnimationWithThen([animateSingleValue(value, target, rest)]);
	if (typeof onComplete === "function") void animation.finished.then(onComplete);
	return animation;
}

export type ShellAnimate = typeof animate;
