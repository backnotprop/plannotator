import type { ReactNode } from "react";

import { useSupportsDockedRail } from "./lib/useSupportsDockedRail";
import {
  DEFAULT_RAIL_STORAGE,
  railStorageKeys,
  readStoredRailOpen,
  savedRailWidth,
  type RailStorage,
  type RailStorageKeys,
} from "./railGeometry";

export function ReservedRailColumn({
  storage = DEFAULT_RAIL_STORAGE,
  storageKeys,
}: {
  storage?: RailStorage;
  storageKeys?: Partial<RailStorageKeys>;
} = {}) {
  const keys = railStorageKeys(storageKeys);
  if (readStoredRailOpen(storage, keys.open) === false) return null;
  return (
    <div
      aria-hidden="true"
      data-rail-reserved
      className="hidden h-full shrink-0 border-r border-frame-divider bg-card md:flex"
      style={{ width: savedRailWidth(keys.width) }}
    />
  );
}

/** Holds the rail's place while the host loads it, so the page does not shift when it arrives. */
export function RailSlot({
  status,
  storage,
  storageKeys,
  children,
}: {
  status: "pending" | "success" | "error";
  storage?: RailStorage;
  storageKeys?: Partial<RailStorageKeys>;
  children: ReactNode;
}) {
  const docked = useSupportsDockedRail();
  if (!docked || status === "error") return null;
  if (status === "pending") return <ReservedRailColumn storage={storage} storageKeys={storageKeys} />;
  return <>{children}</>;
}
