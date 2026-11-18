import { useState, type DragEventHandler, type ReactNode } from "react";

import { motion, type MotionValue } from "motion/react";

import {
  DEFAULT_RAIL_STORAGE,
  RAIL_STORAGE_KEYS,
  readStoredRailOpen,
  writeStoredRailOpen,
  type RailStorage,
} from "./railGeometry";

export interface DocumentRailDefaults {
  open: boolean;
}

/**
 * The rail's open state. Uncontrolled by default (remembered in `storage`); pass
 * `control.open` to own it, and `control.onOpenChange` to hear every request.
 */
export function useDocumentRailState(
  defaults: DocumentRailDefaults = { open: true },
  storage: RailStorage = DEFAULT_RAIL_STORAGE,
  openKey: string = RAIL_STORAGE_KEYS.open,
  control: { open?: boolean; onOpenChange?: (open: boolean) => void } = {},
): {
  railOpen: boolean;
  setRailOpen: (open: boolean) => void;
  openFiles: () => void;
} {
  const [storedOpen, setStoredOpen] = useState<boolean | null>(() => readStoredRailOpen(storage, openKey));
  const controlled = control.open !== undefined;
  const railOpen = controlled ? control.open! : (storedOpen ?? defaults.open);
  const setRailOpen = (next: boolean) => {
    if (!controlled) {
      setStoredOpen(next);
      writeStoredRailOpen(next, storage, openKey);
    }
    control.onOpenChange?.(next);
  };
  return {
    railOpen,
    setRailOpen,
    openFiles: () => {
      setRailOpen(true);
    },
  };
}

export function DocumentRail({
  head,
  children,
  width,
  outerWidth,
  opacity,
  onDragOver,
  onDrop,
}: {
  head: ReactNode;
  children: ReactNode;
  width: MotionValue<number>;
  outerWidth: MotionValue<number>;
  opacity: MotionValue<number>;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
}) {
  return (
    <motion.aside
      aria-label="Page rail"
      data-document-rail=""
      className="hidden h-full shrink-0 flex-col overflow-hidden border-r border-frame-divider bg-card md:flex"
      style={{ width: outerWidth }}
    >
      <motion.div className="flex min-h-0 flex-1 flex-col" style={{ width, opacity }}>
        <div className="shrink-0">{head}</div>
        <div className="min-h-0 flex-1 overflow-y-auto" onDragOver={onDragOver} onDrop={onDrop}>
          <div className="flex min-h-full flex-col py-1">{children}</div>
        </div>
      </motion.div>
    </motion.aside>
  );
}
