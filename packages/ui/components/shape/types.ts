/**
 * `ShapeSurface` is host-neutral like the Inbox thread parts: it never makes a request, reads
 * the address bar, a cookie or storage.
 */
import type { ShapeBoxSelection, ShapeReadAsset } from './boxSelect';
import type { ComponentType, ReactNode, Ref } from 'react';
import type { ShapeCodeTarget, ShapeNote, ShapeNoteInput, ShapeRecord, ShapeVersion, ShapeViewId } from '@plannotator/core/shape';

export type { ShapeBoard, ShapeNote, ShapeNoteInput, ShapeRecord, ShapeRef, ShapeVersion, ShapeViewId } from '@plannotator/core/shape';

/** The agent session that drew the shape, as the host knows it now. */
export interface ShapeSessionStatus {
  state: 'live' | 'busy' | 'gone';
  agent: string;
}

export interface ShapeLoaded {
  shape: ShapeRecord;
  version: ShapeVersion;
  seen: number | null;
  notes: ShapeNote[];
  session: ShapeSessionStatus;
}

export type ShapeEvent =
  /** The agent wrote a new version. */
  | { type: 'version'; shape: ShapeRecord; version: ShapeVersion }
  /** The agent says it is drawing (until a time), or stopped. */
  | { type: 'drawing'; until: string | null }
  /** A note was stored or changed (an answer, a delivery). */
  | { type: 'note'; note: ShapeNote }
  /** Finished, reopened. */
  | { type: 'state'; shape: ShapeRecord }
  | { type: 'session'; session: ShapeSessionStatus };

/** What the Annotate box was opened on, and the optional words. */
export interface ShapeShowMeInput {
  name: string;
  code?: string;
  words: string;
  parts?: string[];
  picture?: Promise<string | null>;
}

export interface ShapeHost {
  load(id: string): Promise<ShapeLoaded>;
  version(id: string, n: number): Promise<ShapeVersion | null>;
  note(id: string, input: ShapeNoteInput): Promise<ShapeNote>;
  ask(id: string, input: ShapeNoteInput, onText: (text: string) => void): Promise<{ question: ShapeNote; answer: ShapeNote | null }>;
  seen(id: string, n: number): void;
  events(id: string, listener: (event: ShapeEvent) => void): () => void;

  showMe?(id: string, input: ShapeShowMeInput): void;
  refresh?(id: string): Promise<void>;
  refreshLabel?: string;
  assetUrl?(id: string, src: string): string;
  readFile?(id: string, path: string): Promise<string | null>;
  fileAction?(id: string, file: { path: string; line?: number }): ReactNode;
  codeHover?(id: string, request: ShapeCodeHoverRequest): Promise<unknown | null>;
  resumePrompt?(id: string): string;
  copy?(text: string): Promise<void> | void;
  askWaitsWhenEnded?: boolean;
  sessionless?: boolean;
}

export interface ShapeBoxOptions {
  readAsset?: ShapeReadAsset;
  onAddToReply?: (selection: ShapeBoxSelection, text: string) => void;
}

export interface ShapeCodeHoverRequest {
  symbol: string;
  filePath: string;
  line: number;
  charStart: number;
  side: 'new';
}

export interface ShapeCodeGuideProps {
  code: NonNullable<ShapeVersion['views']['code']>;
  renderDiff: (file: { path: string; patch: string }) => ReactNode;
  openLine?: (path: string) => number | null;
  onOpenFile?: (path: string, line: number) => void;
  headerActions?: ReactNode;
  fileAction?: (path: string) => ReactNode;
}

export interface ShapeCodeHoverCardProps {
  hover: { request: ShapeCodeHoverRequest; data: never; rect: DOMRect };
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onSelectLocation?: (location: { filePath: string; line: number }) => void;
}

export type ShapePanelTab = 'ask' | 'thread' | 'refs';

/** A place in a review's guided review: a file and line, a guide step (from 1), every file, or (empty) its start. */
export interface ShapeReviewAt {
  path?: string;
  line?: number;
  step?: number;
  files?: boolean;
  narrow?: ShapeReviewNarrow;
}

export interface ShapeReviewNarrow {
  part: string;
  pr: number;
  title?: string;
  url?: string;
  hue?: number;
  files: string[];
}

/** The review a board is part of (the host found it: the Inbox, a review's thread). */
export interface ShapeSurfaceReview {
  label?: string;
  files?: number;
  additions?: number;
  deletions?: number;
  steps?: number;
  open(at: ShapeReviewAt): boolean | Promise<boolean>;
  patch?(): Promise<string | null>;
}

export interface ShapeSurfaceProps {
  host: ShapeHost;
  id: string;
  onClose?: () => void;
  CodeGuide?: ComponentType<ShapeCodeGuideProps>;
  CodeHoverCard?: ComponentType<ShapeCodeHoverCardProps>;
  onCode?: (target: ShapeCodeTarget, el: HTMLElement, version?: ShapeVersion | null) => boolean;
  renderThread?: (options: { flash: string | null }) => ReactNode;
  readFirst?: boolean;
  initialView?: ShapeViewId;
  initialPanel?: ShapePanelTab | null;
  onNavigate?: (state: { view: ShapeViewId; panel: ShapePanelTab | null }) => void;
  headStart?: ReactNode;
  headSide?: ReactNode;
  codeView?: boolean;
  review?: ShapeSurfaceReview | null;
  boxSelect?: ShapeBoxOptions;
  darkContrast?: boolean;
  stackBadges?: boolean;
  dockRef?: Ref<HTMLDivElement>;
  pillRef?: Ref<HTMLDivElement>;
}
