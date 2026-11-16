import { useEffect, useLayoutEffect, useRef, type DragEventHandler, type ReactNode } from "react";

import { useResizablePanel } from "../../hooks/useResizablePanel";
import { useRailMotion } from "./lib/shellMotion";
import { DocumentRail, type DocumentRailDefaults, useDocumentRailState } from "./DocumentRail";
import { PanelEdge } from "./PanelEdge";
import {
  DEFAULT_RAIL_STORAGE,
  RAIL_WIDTH,
  railStorageKeys,
  type RailStorage,
  type RailStorageKeys,
} from "./railGeometry";
import { ShellTabFlags } from "./ShellTabFlags";

export function DocumentRailShell({
  head,
  children,
  defaults,
  fitsForWidth,
  onFlagsChange,
  enabled = true,
  onDragOver,
  onDrop,
  storage = DEFAULT_RAIL_STORAGE,
  storageKeys,
}: {
  head: ReactNode;
  children: ReactNode;
  defaults: DocumentRailDefaults;
  fitsForWidth?: (railWidth: number) => boolean;
  onFlagsChange?: (visible: boolean) => void;
  enabled?: boolean;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  /** Where the open flag is kept. Default: the package's storage helper. */
  storage?: RailStorage;
  storageKeys?: Partial<RailStorageKeys>;
}) {
  const keys = railStorageKeys(storageKeys);
  const rail = useDocumentRailState(defaults, storage, keys.open);
  const railSnapCloseRef = useRef<() => void>(() => {});
  useEffect(() => {
    railSnapCloseRef.current = () => rail.setRailOpen(false);
  });
  const railWidthApplyRef = useRef<(width: number) => void>(() => {});
  const tocResize = useResizablePanel({
    ...RAIL_WIDTH,
    storageKey: keys.width,
    side: "left",
    snapCloseRatio: 0.5,
    onSnapClose: () => railSnapCloseRef.current(),
    onClick: () => railSnapCloseRef.current(),
    apply: (nextWidth) => railWidthApplyRef.current(nextWidth),
  });
  const fits = enabled && (fitsForWidth === undefined || fitsForWidth(tocResize.width));
  const railMotion = useRailMotion(rail.railOpen && fits, tocResize.width);
  useEffect(() => {
    railWidthApplyRef.current = (nextWidth) => railMotion.width.set(nextWidth);
  });
  const flagsVisible = !rail.railOpen && !railMotion.mounted;
  useLayoutEffect(() => {
    onFlagsChange?.(flagsVisible);
  }, [onFlagsChange, flagsVisible]);
  useLayoutEffect(() => () => onFlagsChange?.(false), [onFlagsChange]);

  return (
    <>
      {flagsVisible && <ShellTabFlags onOpenFiles={rail.openFiles} />}
      {railMotion.mounted && enabled && (
        <div className="contents group/sidebar">
          <DocumentRail
            head={head}
            width={railMotion.width}
            outerWidth={railMotion.outerWidth}
            opacity={railMotion.progress}
            onDragOver={onDragOver}
            onDrop={onDrop}
          >
            {children}
          </DocumentRail>
          <PanelEdge
            resize={tocResize}
            className="z-[55] hidden md:flex"
            side="left"
            onCollapse={() => rail.setRailOpen(false)}
            label="Collapse rail"
          />
        </div>
      )}
    </>
  );
}
