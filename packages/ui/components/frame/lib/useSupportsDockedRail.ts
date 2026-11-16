import { useState, useSyncExternalStore } from "react";
import { DOCKED_RAIL_MEDIA_QUERY } from "../railGeometry";

export function useSupportsDockedRail(): boolean {
  const [mediaQuery] = useState(() => window.matchMedia(DOCKED_RAIL_MEDIA_QUERY));
  const [subscribe] = useState(() => (onChange: () => void) => {
    mediaQuery.addEventListener("change", onChange);
    window.addEventListener("resize", onChange);
    return () => {
      mediaQuery.removeEventListener("change", onChange);
      window.removeEventListener("resize", onChange);
    };
  });
  return useSyncExternalStore(subscribe, () => mediaQuery.matches && window.innerWidth >= 640);
}
