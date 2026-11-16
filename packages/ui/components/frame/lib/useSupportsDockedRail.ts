import { useState, useSyncExternalStore } from "react";
import { DOCKED_RAIL_MEDIA_QUERY } from "../railGeometry";

const noSubscription = () => () => {};

export function useSupportsDockedRail(): boolean {
  const [mediaQuery] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(DOCKED_RAIL_MEDIA_QUERY)
      : null,
  );
  const [subscribe] = useState(() =>
    mediaQuery === null
      ? noSubscription
      : (onChange: () => void) => {
          mediaQuery.addEventListener("change", onChange);
          window.addEventListener("resize", onChange);
          return () => {
            mediaQuery.removeEventListener("change", onChange);
            window.removeEventListener("resize", onChange);
          };
        },
  );
  return useSyncExternalStore(
    subscribe,
    () => mediaQuery !== null && mediaQuery.matches && window.innerWidth >= 640,
    () => false,
  );
}
