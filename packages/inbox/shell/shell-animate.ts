// Copied from Workspaces apps/web/src/lib/shell-animate.ts (cd4a9bfd1) for the
// Inbox sidebar (the owner, 2026-10-09: the same component and motion). Port:
// imports from `motion/react`, which re-exports the same framer-motion 12.43.0.

/**
 * The shell spring's animator, in its own chunk (the boot trim after PR 783).
 *
 * framer's animator is not needed to paint the shell: every shell surface
 * mounts SETTLED at 0 or 1, and the first spring runs on the first open or
 * close. lib/shell-motion.ts loads this module right after the shell's first
 * paint and again on demand, so the first toggle finds it loaded.
 *
 * `animate` here is framer's own `animate(motionValue, target, options)`
 * path for one MotionValue, step for step (framer-motion 12
 * animation/animate/index.mjs and subject.mjs): the per-value animation from
 * `animateSingleValue`, wrapped in `GroupAnimationWithThen`, with the
 * top-level `onComplete` run on `finished`. Importing the two pieces instead
 * of `animate` leaves out the sequence and element-subject arms, which the
 * shell never calls, so the chunk the first toggle may wait for is smaller.
 */
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

/** Its type, for lib/shell-motion.ts's type-only import (erased at build). */
export type ShellAnimate = typeof animate;
