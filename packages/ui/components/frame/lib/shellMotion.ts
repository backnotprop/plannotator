/** Spring progress for the rail and docked panels. The animate function loads on first use; reduced motion jumps. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cancelFrame, frame, useMotionValue, type MotionValue } from "motion/react";

import { usePrefersReducedMotion } from "../../../hooks/usePrefersReducedMotion";

import type { ShellAnimate } from "./shellAnimate";

let shellAnimate: ShellAnimate | null = null;
let shellAnimateLoad: Promise<ShellAnimate> | null = null;

export function loadShellAnimate(): Promise<ShellAnimate> {
  shellAnimateLoad ??= import("./shellAnimate").then(
    (module) => {
      shellAnimate = module.animate;
      return module.animate;
    },
    (error: unknown) => {
      shellAnimateLoad = null;
      throw error;
    },
  );
  return shellAnimateLoad;
}

export function preloadShellAnimate(): void {
  if (shellAnimate === null) void loadShellAnimate().catch(() => {});
}

function sameValues(a: readonly MotionValue<number>[], b: readonly MotionValue<number>[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function useCombinedMotionValue<T>(
  values: readonly MotionValue<number>[],
  combine: (latest: number[]) => T,
): MotionValue<T> {
  const combined = useMotionValue<T>(combine(values.map((value) => value.get())));
  const combineRef = useRef(combine);
  const subscriptionRef = useRef<{ values: readonly MotionValue<number>[]; stop: () => void } | null>(null);
  useLayoutEffect(() => {
    combineRef.current = combine;
    const update = () => combined.set(combineRef.current(values.map((value) => value.get())));
    update();
    const current = subscriptionRef.current;
    if (current !== null && sameValues(current.values, values)) return;
    current?.stop();
    const schedule = () => frame.preRender(update, false, true);
    const subscriptions = values.map((value) => value.on("change", schedule));
    subscriptionRef.current = {
      values,
      stop: () => {
        for (const unsubscribe of subscriptions) unsubscribe();
        cancelFrame(update);
      },
    };
  });
  useLayoutEffect(
    () => () => {
      subscriptionRef.current?.stop();
      subscriptionRef.current = null;
    },
    [],
  );
  return combined;
}

export const shellSpring = {
  type: "spring",
  duration: 0.5,
  bounce: 0.1,
} as const;

export interface ShellProgress {
  progress: MotionValue<number>;
  mounted: boolean;
}

export function useShellProgress(open: boolean): ShellProgress {
  const reducedMotion = usePrefersReducedMotion();
  const progress = useMotionValue(open ? 1 : 0);
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    progress.stop();
    const target = open ? 1 : 0;
    if (open) setMounted(true);
    if (reducedMotion) {
      progress.set(target);
      if (!open) setMounted(false);
      return;
    }
    if (progress.get() === target) {
      if (!open) setMounted(false);
      return;
    }
    let controls: { stop: () => void } | null = null;
    let cancelled = false;
    const start = (animate: ShellAnimate) => {
      if (cancelled) return;
      controls = animate(progress, target, {
        ...shellSpring,
        onComplete: () => {
          if (!open) setMounted(false);
        },
      });
    };
    if (shellAnimate !== null) start(shellAnimate);
    else
      void loadShellAnimate().then(start, () => {
        if (cancelled) return;
        progress.set(target);
        if (!open) setMounted(false);
      });
    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, [open, reducedMotion, progress]);

  return { progress, mounted };
}

export interface RailMotion extends ShellProgress {
  width: MotionValue<number>;
  outerWidth: MotionValue<number>;
}

export function useRailMotion(open: boolean, committedWidth: number): RailMotion {
  const { progress, mounted } = useShellProgress(open);
  const width = useMotionValue(committedWidth);
  const outerWidth = useCombinedMotionValue([width, progress], (latest) => {
    const [acceptedWidth, openProgress] = latest as [number, number];
    return acceptedWidth * Math.min(1, Math.max(0, openProgress));
  });

  useEffect(() => {
    width.set(committedWidth);
  }, [width, committedWidth]);

  return { width, progress, outerWidth, mounted };
}
