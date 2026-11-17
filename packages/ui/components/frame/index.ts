// Frame: the page screen around a document (top bar, left rail, page card,
// right panel, phone sheets), host-neutral. The host brings the routing, data
// and controls through slots and callbacks. Import the styles once, in the
// host's Tailwind entry: `@import "@plannotator/ui/frame.css";` (README.md).
export { FrameGround, FrameBox } from "./FrameBox";
export { AppRailBand } from "./AppRailBand";
export { AppRail } from "./AppRail";
export { Breadcrumbs, type CrumbRoot } from "./Breadcrumbs";
export { DocumentRailShell } from "./DocumentRailShell";
export { DocumentRail, useDocumentRailState, type DocumentRailDefaults } from "./DocumentRail";
export { RailSlot, ReservedRailColumn } from "./RailSlot";
export { ShellTabFlags } from "./ShellTabFlags";
export { CollapsibleEdge, type EdgeKeyboardResize } from "./CollapsibleEdge";
export { PanelEdge } from "./PanelEdge";
export { DockedPanelClip } from "./DockedPanelClip";
export {
  DEFAULT_RAIL_STORAGE,
  DOCKED_RAIL_MEDIA_QUERY,
  RAIL_STORAGE_KEYS,
  RAIL_WIDTH,
  railFitsRow,
  readStoredRailOpen,
  savedRailWidth,
  writeStoredRailOpen,
  type RailStorage,
  type RailStorageKeys,
} from "./railGeometry";
export { PageHeader, PageCard } from "./page/PageCard";
export { ReadingLine, type OlderVersion } from "./page/ReadingLine";
export { PagesRailHead } from "./rail/PagesRailHead";
export {
  FilesRailHeading,
  FilesRailFilter,
  FilesRailLoading,
  FilesRailError,
  FilesRailEmpty,
  FilesRailNoMatch,
  FilesRailRows,
  FileRow,
  FolderRow,
  RAIL_ICON_BUTTON,
} from "./rail/FilesRail";
export { RAIL_ROW, RAIL_SUB_ROW, RAIL_ADD_ROW, RAIL_HINT, RailAddRowLabel, RailTerminal } from "./rail/railRow";
export { ROW, FIELD_ROW, FIELD_IN_ROW, INDENT, SIDEBAR_COLLECTION_NAME_TEXT, pad } from "./rail/rowStyle";
export { fileIcon, FolderIcon, FolderOpenIcon, type FileGlyph, type FileIconKind } from "./rail/fileIcons";
export { RailSheet } from "./sheets/RailSheet";
export { CommentsSheet } from "./sheets/CommentsSheet";
export { VersionsSheet } from "./sheets/VersionsSheet";
export {
  VersionsPanel,
  VersionActions,
  type VersionRowPlace,
  type VersionRowContext,
} from "./versions/VersionsPanel";
export * from "./versions/versionsModel";
export { useRailMotion, useShellProgress, type RailMotion, type ShellProgress } from "./lib/shellMotion";
export { useSupportsDockedRail } from "./lib/useSupportsDockedRail";
export { useRowWidthAtRest } from "./lib/useRowWidthAtRest";
export { whenWords } from "./lib/formatTime";
export { cn as frameCn } from "./lib/utils";
export * from "./lib/recipes";
export { Button as FrameButton, buttonVariants as frameButtonVariants } from "./primitives/button";
export {
  Card,
  CardFaceDocument,
  CardRow,
  CardRows,
  CardGrid,
  CardGroup,
  CardGroups,
  CARD_FACE_WIDTH,
  cardDateWords,
  cardName,
  type CardImageFace,
  type CardKind,
  type CardLinkProps,
  type CardProps,
  type CardRowProps,
  type CardSize,
} from "./card/Card";
export { CARD_MOTIONS, CardArrival, arrive, settleBatch, type CardMotion } from "./card/motions";
export { CardUpdatesPill } from "./card/CardUpdatesPill";
