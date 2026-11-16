/** Spring progress for the rail and docked panels. The animate function loads on first use; reduced motion jumps. */
import { useEffect, useLayoutEffect, useState } from "react";

import { cancelFrame, frame, useMotionValue, type MotionValue } from "motion/react";

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

export function useCombinedMotionValue<T>(
  values: readonly MotionValue<number>[],
  combine: (latest: number[]) => T,
): MotionValue<T> {
  const read = () => combine(values.map((value) => value.get()));
  const combined = useMotionValue<T>(read());
  const update = () => combined.set(read());
  update();
  useLayoutEffect(() => {
    const schedule = () => frame.preRender(update, false, true);
    const subscriptions = values.map((value) => value.on("change", schedule));
    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
      cancelFrame(update);
    };
  });
  return combined;
}

export const shellSpring = {
  type: "spring",
  duration: 0.5,
  bounce: 0.1,
} as const;

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

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
